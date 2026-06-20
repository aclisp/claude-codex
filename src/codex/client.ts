import type { ResponseInput, ResponseOutputItem } from 'openai/resources/responses/responses.js';
import type { InternalAssistantEvent } from '../protocol/events.ts';
import { createRequestId } from '../runtime/id.ts';
import type { CodexAuthReader, CodexCredentials } from './auth.ts';
import { buildSseHeaders, buildWebSocketHeaders } from './headers.ts';
import type { CodexResponsesRequest } from './request.ts';
import { CodexApiError, CodexProtocolError, mapRawCodexEvents, processCodexStream } from './stream.ts';
import { resolveCodexUrl, resolveCodexWebSocketUrl } from './url.ts';

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60_000;

export interface CodexClientOptions {
    baseUrl: string;
    authReader: CodexAuthReader;
    websocketConnectTimeoutMs: number;
    upstreamIdleTimeoutMs: number;
    fetchFn?: FetchLike;
    WebSocketCtor?: WebSocketConstructorLike | null;
}

export interface CodexStreamOptions {
    sessionId: string;
    signal?: AbortSignal;
}

export interface CodexStreamResult {
    transport: 'websocket' | 'sse';
    events: AsyncIterable<InternalAssistantEvent>;
}

type WebSocketEventType = 'open' | 'message' | 'error' | 'close';
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
    readyState?: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
    removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

type WebSocketConstructorLike = new (url: string, protocolsOrOptions?: unknown) => WebSocketLike;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CachedWebSocketContinuation {
    lastRequestBody: CodexResponsesRequest;
    lastResponseId: string;
    lastResponseItems: ResponseOutputItem[];
}

interface CachedWebSocketConnection {
    socket: WebSocketLike;
    busy: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
    continuation?: CachedWebSocketContinuation;
}

interface AcquiredWebSocket {
    socket: WebSocketLike;
    entry?: CachedWebSocketConnection;
    release: (options?: { keep?: boolean }) => void;
}

export class CodexClient {
    private readonly fetchFn: FetchLike;
    private readonly WebSocketCtor: WebSocketConstructorLike | null;
    private readonly websocketCache = new Map<string, CachedWebSocketConnection>();
    private readonly websocketFallbackSessions = new Set<string>();

    constructor(private readonly options: CodexClientOptions) {
        this.fetchFn = options.fetchFn ?? fetch;
        this.WebSocketCtor =
            options.WebSocketCtor === undefined ? ((globalThis as { WebSocket?: WebSocketConstructorLike }).WebSocket ?? null) : options.WebSocketCtor;
    }

    stream(body: CodexResponsesRequest, options: CodexStreamOptions): CodexStreamResult {
        if (this.websocketFallbackSessions.has(options.sessionId) || !this.WebSocketCtor) {
            return {
                transport: 'sse',
                events: this.streamSse(body, options),
            };
        }

        let sawWebSocketEvent = false;
        const websocketEvents = this.streamWebSocket(body, options, () => {
            sawWebSocketEvent = true;
        });

        return {
            transport: 'websocket',
            events: this.withWebSocketFallback(websocketEvents, body, options, () => sawWebSocketEvent),
        };
    }

    close(): void {
        for (const entry of this.websocketCache.values()) {
            closeWebSocketSilently(entry.socket, 1000, 'shutdown');
            if (entry.idleTimer) {
                clearTimeout(entry.idleTimer);
            }
        }
        this.websocketCache.clear();
    }

    private async *withWebSocketFallback(
        websocketEvents: AsyncIterable<InternalAssistantEvent>,
        body: CodexResponsesRequest,
        options: CodexStreamOptions,
        sawWebSocketEvent: () => boolean,
    ): AsyncGenerator<InternalAssistantEvent> {
        try {
            yield* websocketEvents;
        } catch (error) {
            this.websocketFallbackSessions.add(options.sessionId);
            if (sawWebSocketEvent()) {
                throw error;
            }
            yield* this.streamSse(body, options);
        }
    }

    private async *streamSse(body: CodexResponsesRequest, options: CodexStreamOptions): AsyncGenerator<InternalAssistantEvent> {
        let credentials = await this.options.authReader.read();
        try {
            yield* this.processRawEvents(this.createSseRawEvents(body, credentials, options), body);
        } catch (error) {
            if (error instanceof CodexApiError && (error.httpStatus === 401 || error.httpStatus === 403)) {
                credentials = await this.options.authReader.read({ force: true });
                yield* this.processRawEvents(this.createSseRawEvents(body, credentials, options), body);
                return;
            }
            throw error;
        }
    }

    private async *streamWebSocket(body: CodexResponsesRequest, options: CodexStreamOptions, onRawEvent: () => void): AsyncGenerator<InternalAssistantEvent> {
        const credentials = await this.options.authReader.read();
        const acquired = await this.acquireWebSocket(credentials, options);
        let keepConnection = true;
        const fullBody = body;
        const requestBody = acquired.entry ? buildCachedWebSocketRequestBody(acquired.entry, fullBody) : fullBody;
        const responseItems: ResponseOutputItem[] = [];
        let responseId: string | undefined;

        try {
            acquired.socket.send(JSON.stringify({ type: 'response.create', ...requestBody }));
            yield* this.processRawEvents(
                tapRawEvents(parseWebSocket(acquired.socket, options.signal, this.options.upstreamIdleTimeoutMs), onRawEvent),
                requestBody,
                {
                    onResponseId: (id) => {
                        responseId = id;
                    },
                    onOutputItemDone: (item) => {
                        responseItems.push(item);
                    },
                },
            );
            if (options.signal?.aborted) {
                keepConnection = false;
            } else if (acquired.entry && responseId) {
                acquired.entry.continuation = {
                    lastRequestBody: fullBody,
                    lastResponseId: responseId,
                    lastResponseItems: responseItems,
                };
            }
        } catch (error) {
            keepConnection = false;
            if (acquired.entry) {
                acquired.entry.continuation = undefined;
            }
            throw error;
        } finally {
            acquired.release({ keep: keepConnection });
        }
    }

    private async *processRawEvents(
        rawEvents: AsyncIterable<Record<string, unknown>>,
        body: CodexResponsesRequest,
        callbacks?: {
            onResponseId?: (responseId: string) => void;
            onOutputItemDone?: (item: ResponseOutputItem) => void;
        },
    ): AsyncGenerator<InternalAssistantEvent> {
        yield* processCodexStream(mapRawCodexEvents(rawEvents), {
            model: body.model,
            onResponseId: callbacks?.onResponseId,
            onOutputItemDone: callbacks?.onOutputItemDone,
        });
    }

    private async *createSseRawEvents(
        body: CodexResponsesRequest,
        credentials: CodexCredentials,
        options: CodexStreamOptions,
    ): AsyncGenerator<Record<string, unknown>> {
        const response = await this.fetchFn(resolveCodexUrl(this.options.baseUrl), {
            method: 'POST',
            headers: buildSseHeaders(credentials, options.sessionId),
            body: JSON.stringify(body),
            signal: options.signal,
        });

        if (!response.ok) {
            throw await createCodexHttpError(response);
        }

        yield* parseSse(response, options.signal);
    }

    private async acquireWebSocket(credentials: CodexCredentials, options: CodexStreamOptions): Promise<AcquiredWebSocket> {
        const cached = this.websocketCache.get(options.sessionId);
        if (cached && !cached.busy && isWebSocketReusable(cached.socket)) {
            if (cached.idleTimer) {
                clearTimeout(cached.idleTimer);
                cached.idleTimer = undefined;
            }
            cached.busy = true;
            return {
                socket: cached.socket,
                entry: cached,
                release: ({ keep = true } = {}) => {
                    cached.busy = false;
                    if (!keep || !isWebSocketReusable(cached.socket)) {
                        closeWebSocketSilently(cached.socket);
                        this.websocketCache.delete(options.sessionId);
                        return;
                    }
                    this.scheduleWebSocketExpiry(options.sessionId, cached);
                },
            };
        }

        if (cached?.busy) {
            const socket = await this.connectWebSocket(credentials, createRequestId(), options.signal);
            return {
                socket,
                release: () => closeWebSocketSilently(socket),
            };
        }

        if (cached && !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            this.websocketCache.delete(options.sessionId);
        }

        const socket = await this.connectWebSocket(credentials, options.sessionId, options.signal);
        const entry: CachedWebSocketConnection = {
            socket,
            busy: true,
        };
        this.websocketCache.set(options.sessionId, entry);

        return {
            socket,
            entry,
            release: ({ keep = true } = {}) => {
                entry.busy = false;
                if (!keep || !isWebSocketReusable(entry.socket)) {
                    closeWebSocketSilently(entry.socket);
                    if (this.websocketCache.get(options.sessionId) === entry) {
                        this.websocketCache.delete(options.sessionId);
                    }
                    return;
                }
                this.scheduleWebSocketExpiry(options.sessionId, entry);
            },
        };
    }

    private async connectWebSocket(credentials: CodexCredentials, requestId: string, signal?: AbortSignal): Promise<WebSocketLike> {
        if (!this.WebSocketCtor) {
            throw new Error('WebSocket transport is not available in this runtime.');
        }

        const headers = headersToRecord(buildWebSocketHeaders(credentials, requestId));
        const WebSocketCtor = this.WebSocketCtor;
        return new Promise<WebSocketLike>((resolve, reject) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let socket: WebSocketLike;

            try {
                socket = new WebSocketCtor(resolveCodexWebSocketUrl(this.options.baseUrl), { headers });
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            const cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onError);
                socket.removeEventListener('close', onClose);
                signal?.removeEventListener('abort', onAbort);
            };
            const fail = (error: Error, closeReason?: string) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (closeReason) {
                    closeWebSocketSilently(socket, 1000, closeReason);
                }
                reject(error);
            };
            const onOpen = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(socket);
            };
            const onError: WebSocketListener = (event) => fail(extractWebSocketError(event));
            const onClose: WebSocketListener = (event) => fail(extractWebSocketCloseError(event));
            const onAbort = () => fail(new Error('Request was aborted'), 'aborted');

            socket.addEventListener('open', onOpen);
            socket.addEventListener('error', onError);
            socket.addEventListener('close', onClose);
            signal?.addEventListener('abort', onAbort);

            if (this.options.websocketConnectTimeoutMs > 0) {
                timeout = setTimeout(
                    () => fail(new Error(`WebSocket connect timeout after ${this.options.websocketConnectTimeoutMs}ms`), 'connect_timeout'),
                    this.options.websocketConnectTimeoutMs,
                );
            }
            if (signal?.aborted) {
                onAbort();
            }
        });
    }

    private scheduleWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
        }
        entry.idleTimer = setTimeout(() => {
            if (entry.busy) {
                return;
            }
            closeWebSocketSilently(entry.socket, 1000, 'idle_timeout');
            this.websocketCache.delete(sessionId);
        }, SESSION_WEBSOCKET_CACHE_TTL_MS);
    }
}

async function* parseSse(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    if (!response.body) {
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const onAbort = () => {
        void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error('Request was aborted');
            }

            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });

            let separatorIndex = buffer.indexOf('\n\n');
            while (separatorIndex !== -1) {
                const chunk = buffer.slice(0, separatorIndex);
                buffer = buffer.slice(separatorIndex + 2);
                const data = chunk
                    .split('\n')
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trim())
                    .join('\n')
                    .trim();
                if (data && data !== '[DONE]') {
                    try {
                        yield JSON.parse(data) as Record<string, unknown>;
                    } catch {
                        throw new CodexProtocolError('Invalid Codex SSE JSON.', { payload: data });
                    }
                }
                separatorIndex = buffer.indexOf('\n\n');
            }
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
            await reader.cancel();
        } catch {}
    }
}

async function* parseWebSocket(socket: WebSocketLike, signal?: AbortSignal, idleTimeoutMs?: number): AsyncGenerator<Record<string, unknown>> {
    const queue: Record<string, unknown>[] = [];
    let pending: (() => void) | undefined;
    let done = false;
    let failed: Error | undefined;
    let sawCompletion = false;

    const wake = () => {
        const resolve = pending;
        pending = undefined;
        resolve?.();
    };

    const onMessage: WebSocketListener = (event) => {
        void (async () => {
            try {
                const data = await decodeWebSocketData((event as { data?: unknown }).data);
                if (!data) {
                    return;
                }
                const parsed = JSON.parse(data) as Record<string, unknown>;
                const type = typeof parsed.type === 'string' ? parsed.type : '';
                if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
                    sawCompletion = true;
                    done = true;
                }
                queue.push(parsed);
                wake();
            } catch {
                failed = new CodexProtocolError('Invalid Codex WebSocket JSON.');
                done = true;
                wake();
            }
        })();
    };
    const onError: WebSocketListener = (event) => {
        failed = extractWebSocketError(event);
        done = true;
        wake();
    };
    const onClose: WebSocketListener = (event) => {
        if (!sawCompletion && !failed) {
            failed = extractWebSocketCloseError(event);
        }
        done = true;
        wake();
    };
    const onAbort = () => {
        failed = new Error('Request was aborted');
        done = true;
        wake();
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    signal?.addEventListener('abort', onAbort);

    try {
        while (true) {
            if (queue.length > 0) {
                const event = queue.shift();
                if (event) {
                    yield event;
                }
                continue;
            }
            if (done) {
                break;
            }
            let timeout: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((resolve) => {
                pending = resolve;
                if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
                    timeout = setTimeout(() => {
                        failed = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
                        done = true;
                        closeWebSocketSilently(socket, 1000, 'idle_timeout');
                        wake();
                    }, idleTimeoutMs);
                }
            }).finally(() => {
                if (timeout) {
                    clearTimeout(timeout);
                }
            });
        }

        if (failed) {
            throw failed;
        }
        if (!sawCompletion) {
            throw new Error('WebSocket stream closed before response.completed.');
        }
    } finally {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
    }
}

async function* tapRawEvents(events: AsyncIterable<Record<string, unknown>>, onEvent: () => void): AsyncGenerator<Record<string, unknown>> {
    for await (const event of events) {
        onEvent();
        yield event;
    }
}

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: CodexResponsesRequest): CodexResponsesRequest {
    if (!entry.continuation) {
        return body;
    }

    const delta = getCachedWebSocketInputDelta(body, entry.continuation);
    if (!delta) {
        entry.continuation = undefined;
        return body;
    }

    return {
        ...body,
        previous_response_id: entry.continuation.lastResponseId,
        input: delta,
    };
}

function getCachedWebSocketInputDelta(body: CodexResponsesRequest, continuation: CachedWebSocketContinuation): ResponseInput | undefined {
    if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
        return undefined;
    }

    const currentInput = body.input ?? [];
    const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems] as ResponseInput;
    if (currentInput.length < baseline.length) {
        return undefined;
    }
    if (JSON.stringify(currentInput.slice(0, baseline.length)) !== JSON.stringify(baseline)) {
        return undefined;
    }
    return currentInput.slice(baseline.length);
}

function requestBodiesMatchExceptInput(a: CodexResponsesRequest, b: CodexResponsesRequest): boolean {
    const { input: _aInput, previous_response_id: _aPreviousResponseId, ...aRest } = a;
    const { input: _bInput, previous_response_id: _bPreviousResponseId, ...bRest } = b;
    return JSON.stringify(aRest) === JSON.stringify(bRest);
}

async function createCodexHttpError(response: Response): Promise<CodexApiError> {
    const raw = await response.text().catch(() => '');
    let message = raw || response.statusText || `Codex request failed with status ${response.status}`;
    let code: string | undefined;

    try {
        const parsed = JSON.parse(raw) as { error?: { code?: string; type?: string; message?: string } };
        code = parsed.error?.code ?? parsed.error?.type;
        message = parsed.error?.message ?? message;
    } catch {
        // Keep raw text.
    }

    return new CodexApiError(message, {
        code,
        httpStatus: response.status,
        payload: raw,
    });
}

function headersToRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
        result[key] = value;
    }
    return result;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
    return socket.readyState === undefined || socket.readyState === 1;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = 'done'): void {
    try {
        socket.close(code, reason);
    } catch {}
}

async function decodeWebSocketData(data: unknown): Promise<string | undefined> {
    if (typeof data === 'string') {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(data);
    }
    if (data instanceof Blob) {
        return data.text();
    }
    if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return undefined;
}

function extractWebSocketError(event: unknown): Error {
    const error = (event as { error?: unknown }).error;
    if (error instanceof Error) {
        return error;
    }
    const message = (event as { message?: unknown }).message;
    return new Error(typeof message === 'string' ? message : 'WebSocket error.');
}

function extractWebSocketCloseError(event: unknown): Error {
    const code = (event as { code?: unknown }).code;
    const reason = (event as { reason?: unknown }).reason;
    const codeText = typeof code === 'number' ? ` code ${code}` : '';
    const reasonText = typeof reason === 'string' && reason.length > 0 ? `: ${reason}` : '';
    return new Error(`WebSocket closed${codeText}${reasonText}.`);
}
