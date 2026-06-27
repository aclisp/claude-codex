import type { ResponseInput, ResponseOutputItem } from 'openai/resources/responses/responses.js';
import type { InternalAssistantEvent } from '../protocol/events.ts';
import { createRequestId } from '../runtime/id.ts';
import type { CodexAuthReader, CodexCredentials } from './auth.ts';
import { countTranslatedTokens } from './count-tokens.ts';
import { buildSseHeaders, buildWebSocketHeaders } from './headers.ts';
import type { CodexResponsesRequest } from './request.ts';
import { CodexApiError, CodexProtocolError, createReplayInputItemFromResponseOutputItem, mapRawCodexEvents, processCodexStream } from './stream.ts';
import { resolveCodexUrl, resolveCodexWebSocketUrl } from './url.ts';

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60_000;
const WEBSOCKET_FALLBACK_INITIAL_COOLDOWN_MS = 60_000;
const WEBSOCKET_FALLBACK_MAX_COOLDOWN_MS = 10 * 60_000;

export interface CodexClientOptions {
    baseUrl: string;
    upstreamProxyUrl?: string;
    authReader: CodexAuthReader;
    websocketConnectTimeoutMs: number;
    upstreamIdleTimeoutMs: number;
    fetchFn?: FetchLike;
    WebSocketCtor?: WebSocketConstructorLike | null;
    onTransportFallback?: (event: CodexTransportFallbackEvent) => void;
    websocketFallbackInitialCooldownMs?: number;
    websocketFallbackMaxCooldownMs?: number;
    nowFn?: () => number;
}

export interface CodexStreamOptions {
    sessionId: string;
    signal?: AbortSignal;
    onUpstreamRequest?: (diagnostic: CodexUpstreamRequestDiagnostic) => void;
}

export interface CodexStreamResult {
    transport: 'websocket' | 'sse';
    events: AsyncIterable<InternalAssistantEvent>;
}

export interface CodexTransportFallbackEvent {
    sessionId: string;
    from: 'websocket';
    to: 'sse';
    reason: string;
}

export interface CodexUpstreamRequestDiagnostic {
    sentInputTokens: number;
    sentInputItems: number;
    websocketContinuation?: 'none' | 'full' | 'delta';
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

interface BunRequestInit extends RequestInit {
    proxy?: string;
}

interface BunWebSocketOptions {
    headers: Record<string, string>;
    proxy?: string;
}

interface CachedWebSocketContinuation {
    lastRequestBody: CodexResponsesRequest;
    lastResponseId: string;
    lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
    socket: WebSocketLike;
    busy: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
    continuation?: CachedWebSocketContinuation;
}

interface WebSocketCooldown {
    untilMs: number;
    failures: number;
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
    private readonly websocketCooldowns = new Map<string, WebSocketCooldown>();

    constructor(private readonly options: CodexClientOptions) {
        this.fetchFn = options.fetchFn ?? fetch;
        this.WebSocketCtor =
            options.WebSocketCtor === undefined ? ((globalThis as { WebSocket?: WebSocketConstructorLike }).WebSocket ?? null) : options.WebSocketCtor;
    }

    stream(body: CodexResponsesRequest, options: CodexStreamOptions): CodexStreamResult {
        if (!this.WebSocketCtor || this.isWebSocketCooldownActive(options.sessionId)) {
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
            const sawEvent = sawWebSocketEvent();
            this.rememberWebSocketFailure(options.sessionId);
            this.options.onTransportFallback?.({
                sessionId: options.sessionId,
                from: 'websocket',
                to: 'sse',
                reason: describeError(error),
            });
            if (sawEvent) {
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
        const builtRequest = acquired.entry ? buildCachedWebSocketRequestBody(acquired.entry, fullBody) : { body: fullBody, websocketContinuation: undefined };
        const requestBody = builtRequest.body;
        const responseItems: ResponseInput = [];
        let responseId: string | undefined;

        try {
            options.onUpstreamRequest?.(createUpstreamRequestDiagnostic(requestBody, builtRequest.websocketContinuation));
            acquired.socket.send(JSON.stringify({ type: 'response.create', ...requestBody }));
            yield* this.processRawEvents(
                tapRawEvents(parseWebSocket(acquired.socket, options.signal, this.options.upstreamIdleTimeoutMs), onRawEvent),
                requestBody,
                {
                    onResponseId: (id) => {
                        responseId = id;
                    },
                    onOutputItemDone: (item) => {
                        const replayItem = createReplayInputItemFromResponseOutputItem(item);
                        if (replayItem) {
                            responseItems.push(replayItem);
                        }
                    },
                },
            );
            if (options.signal?.aborted) {
                keepConnection = false;
            } else {
                this.websocketCooldowns.delete(options.sessionId);
                if (acquired.entry && responseId) {
                    acquired.entry.continuation = {
                        lastRequestBody: fullBody,
                        lastResponseId: responseId,
                        lastResponseItems: responseItems,
                    };
                }
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
        options.onUpstreamRequest?.(createUpstreamRequestDiagnostic(body));
        const requestInit: BunRequestInit = {
            method: 'POST',
            headers: buildSseHeaders(credentials, options.sessionId),
            body: JSON.stringify(body),
            signal: options.signal,
        };
        if (this.options.upstreamProxyUrl) {
            requestInit.proxy = this.options.upstreamProxyUrl;
        }

        const response = await this.fetchFn(resolveCodexUrl(this.options.baseUrl), requestInit);

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
        const websocketOptions: BunWebSocketOptions = { headers };
        if (this.options.upstreamProxyUrl) {
            websocketOptions.proxy = this.options.upstreamProxyUrl;
        }
        const WebSocketCtor = this.WebSocketCtor;
        return new Promise<WebSocketLike>((resolve, reject) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let socket: WebSocketLike;

            try {
                socket = new WebSocketCtor(resolveCodexWebSocketUrl(this.options.baseUrl), websocketOptions);
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

    private isWebSocketCooldownActive(sessionId: string): boolean {
        const cooldown = this.websocketCooldowns.get(sessionId);
        if (!cooldown) {
            return false;
        }
        return cooldown.untilMs > this.now();
    }

    private rememberWebSocketFailure(sessionId: string): void {
        const previous = this.websocketCooldowns.get(sessionId);
        const failures = (previous?.failures ?? 0) + 1;
        const initialCooldownMs = this.options.websocketFallbackInitialCooldownMs ?? WEBSOCKET_FALLBACK_INITIAL_COOLDOWN_MS;
        const maxCooldownMs = this.options.websocketFallbackMaxCooldownMs ?? WEBSOCKET_FALLBACK_MAX_COOLDOWN_MS;
        const cooldownMs = Math.min(initialCooldownMs * 2 ** Math.max(0, failures - 1), maxCooldownMs);
        this.websocketCooldowns.set(sessionId, {
            failures,
            untilMs: this.now() + cooldownMs,
        });
    }

    private now(): number {
        return this.options.nowFn?.() ?? Date.now();
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

function createUpstreamRequestDiagnostic(body: CodexResponsesRequest, websocketContinuation?: CodexUpstreamRequestDiagnostic['websocketContinuation']) {
    return {
        sentInputTokens: countTranslatedTokens(body),
        sentInputItems: body.input.length,
        websocketContinuation,
    };
}

function buildCachedWebSocketRequestBody(
    entry: CachedWebSocketConnection,
    body: CodexResponsesRequest,
): { body: CodexResponsesRequest; websocketContinuation: CodexUpstreamRequestDiagnostic['websocketContinuation'] } {
    if (!entry.continuation) {
        return { body, websocketContinuation: 'none' };
    }

    const delta = getCachedWebSocketInputDelta(body, entry.continuation);
    if (!delta) {
        entry.continuation = undefined;
        return { body, websocketContinuation: 'full' };
    }

    return {
        body: {
            ...body,
            previous_response_id: entry.continuation.lastResponseId,
            input: delta,
        },
        websocketContinuation: 'delta',
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
    if (!inputPrefixMatches(currentInput, baseline)) {
        return undefined;
    }
    return currentInput.slice(baseline.length);
}

function inputPrefixMatches(currentInput: ResponseInput, baseline: ResponseInput): boolean {
    for (let index = 0; index < baseline.length; index += 1) {
        if (!inputItemsMatch(currentInput[index], baseline[index])) {
            return false;
        }
    }
    return true;
}

function inputItemsMatch(current: unknown, baseline: unknown): boolean {
    if (isAssistantMessageItem(current) && isAssistantMessageItem(baseline)) {
        const { id: _currentId, ...currentRest } = current;
        const { id: _baselineId, ...baselineRest } = baseline;
        return JSON.stringify(currentRest) === JSON.stringify(baselineRest);
    }
    return JSON.stringify(current) === JSON.stringify(baseline);
}

function isAssistantMessageItem(value: unknown): value is { type: 'message'; role: 'assistant'; id?: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { type?: unknown }).type === 'message' &&
        (value as { role?: unknown }).role === 'assistant'
    );
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

function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.name;
    }
    return String(error);
}
