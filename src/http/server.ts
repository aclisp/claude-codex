import { appendFile } from 'node:fs/promises';
import { parseAnthropicRequest } from '../anthropic/request.ts';
import { collectAnthropicMessage } from '../anthropic/response.ts';
import { encodeSseFrame, toAnthropicSseFrames } from '../anthropic/sse.ts';
import type { CodexClient } from '../codex/client.ts';
import { countTranslatedTokens } from '../codex/count-tokens.ts';
import { CODEX_MODEL_CATALOG } from '../codex/models.ts';
import { buildCodexRequest } from '../codex/request.ts';
import { isProxyError, ProxyError, ProxyValidationError, toAnthropicErrorBody } from '../protocol/errors.ts';
import type { InternalAssistantEvent } from '../protocol/events.ts';
import type { ProxyRuntimeConfig } from '../runtime/config.ts';
import { createSessionStore, type SessionStore } from '../sessions/store.ts';

export interface ProxyServerDependencies {
    codexClient: CodexClient;
    sessionStore?: SessionStore;
    logger?: ProxyLogger;
}

export interface ProxyLogger {
    info(event: Record<string, unknown>): void;
    error(event: Record<string, unknown>): void;
}

export interface ProxyServer {
    fetch(request: Request): Promise<Response>;
}

const JSON_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
};

const SSE_HEADERS = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
};

const STREAM_KEEPALIVE_INTERVAL_MS = 15_000;

export function createProxyServer(config: ProxyRuntimeConfig, dependencies: ProxyServerDependencies): ProxyServer {
    const sessionStore = dependencies.sessionStore ?? createSessionStore(config.stateDir);
    const logger = dependencies.logger ?? consoleLogger;

    return {
        async fetch(request: Request): Promise<Response> {
            const startedAt = Date.now();
            const url = new URL(request.url);

            try {
                if (request.method === 'GET' && url.pathname === '/v1/models') {
                    const response = jsonResponse(createModelsResponse());
                    logRequest(logger, startedAt, { route: url.pathname, status: response.status });
                    return response;
                }

                if (request.method === 'POST' && url.pathname === '/v1/messages') {
                    const response = await handleMessages(request, config, dependencies.codexClient, sessionStore, logger, startedAt);
                    return response;
                }

                if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
                    const response = await handleCountTokens(request, config, logger, startedAt);
                    return response;
                }

                if (request.method === 'OPTIONS') {
                    return new Response(null, { status: 204 });
                }

                return jsonError(
                    new ProxyError(`Route ${request.method} ${url.pathname} is not implemented.`, { httpStatus: 404, errorType: 'invalid_request_error' }),
                );
            } catch (error) {
                const normalized = normalizeError(error);
                const response = jsonError(normalized);
                logRequest(logger, startedAt, {
                    route: url.pathname,
                    status: response.status,
                    error: response.status,
                    errorType: normalized.errorType,
                    errorMessage: normalized.message,
                });
                return response;
            }
        },
    };
}

async function handleMessages(
    request: Request,
    config: ProxyRuntimeConfig,
    codexClient: CodexClient,
    sessionStore: SessionStore,
    logger: ProxyLogger,
    startedAt: number,
): Promise<Response> {
    const rawBody = await readJsonBody(request, config.maxBodyBytes);
    await traceDebugBody(config, rawBody);

    const anthropicRequest = parseAnthropicRequest(rawBody);
    const session = await sessionStore.resolve(request.headers);
    const codexBody = buildCodexRequest(anthropicRequest, {
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        promptCacheKey: clampPromptCacheKey(session.sessionId),
        textVerbosity: config.textVerbosity,
    });

    const abortController = new AbortController();
    const result = codexClient.stream(codexBody, {
        sessionId: session.sessionId,
        signal: abortController.signal,
    });

    if (anthropicRequest.stream === true) {
        const response = await createStreamingResponse(result.events, abortController, logger, startedAt, {
            route: '/v1/messages',
            model: codexBody.model,
            sessionId: session.sessionId,
            transport: result.transport,
        });
        return response;
    }

    const events: InternalAssistantEvent[] = [];
    for await (const event of result.events) {
        events.push(event);
    }
    const message = collectAnthropicMessage(events);
    logRequest(logger, startedAt, {
        route: '/v1/messages',
        model: codexBody.model,
        sessionId: session.sessionId,
        transport: result.transport,
        status: 200,
        stopReason: message.stop_reason,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens,
    });
    return jsonResponse(message);
}

async function handleCountTokens(request: Request, config: ProxyRuntimeConfig, logger: ProxyLogger, startedAt: number): Promise<Response> {
    const rawBody = await readJsonBody(request, config.maxBodyBytes);
    await traceDebugBody(config, rawBody);

    const anthropicRequest = parseAnthropicRequest(rawBody, { requireMaxTokens: false });
    const codexBody = buildCodexRequest(anthropicRequest, {
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        textVerbosity: config.textVerbosity,
    });
    const inputTokens = countTranslatedTokens(codexBody);
    const response = jsonResponse({ input_tokens: inputTokens });
    logRequest(logger, startedAt, {
        route: '/v1/messages/count_tokens',
        model: codexBody.model,
        status: response.status,
        inputTokens,
    });
    return response;
}

async function createStreamingResponse(
    events: AsyncIterable<InternalAssistantEvent>,
    abortController: AbortController,
    logger: ProxyLogger,
    startedAt: number,
    logFields: Record<string, unknown>,
): Promise<Response> {
    const iterator = events[Symbol.asyncIterator]();
    let first: IteratorResult<InternalAssistantEvent>;
    try {
        first = await iterator.next();
    } catch (error) {
        return jsonError(normalizeError(error));
    }

    if (first.done) {
        return jsonError(new ProxyError('Codex stream ended before producing a message.', { httpStatus: 502, errorType: 'api_error' }));
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let status = 200;
            let stopReason: string | undefined;
            let inputTokens: number | undefined;
            let outputTokens: number | undefined;
            let cacheReadInputTokens: number | undefined;
            try {
                enqueueEvent(controller, encoder, first.value);
                let pendingNext = iterator.next();
                while (true) {
                    const next = await nextEventOrKeepalive(pendingNext);
                    if (next === 'keepalive') {
                        enqueuePing(controller, encoder);
                        continue;
                    }
                    if (next.done) {
                        break;
                    }
                    pendingNext = iterator.next();
                    const event = next.value;
                    if (event.type === 'message_end') {
                        stopReason = event.stopReason;
                        inputTokens = event.usage?.inputTokens;
                        outputTokens = event.usage?.outputTokens;
                        cacheReadInputTokens = event.usage?.cacheReadInputTokens;
                    }
                    enqueueEvent(controller, encoder, event);
                }
            } catch (error) {
                status = normalizeError(error).httpStatus;
                enqueueError(controller, encoder, normalizeError(error));
            } finally {
                logRequest(logger, startedAt, {
                    ...logFields,
                    status,
                    stopReason,
                    inputTokens,
                    outputTokens,
                    cacheReadInputTokens,
                });
                controller.close();
            }
        },
        async cancel() {
            abortController.abort();
            await iterator.return?.();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: SSE_HEADERS,
    });
}

function enqueueEvent(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: InternalAssistantEvent): void {
    for (const frame of toAnthropicSseFrames([event])) {
        controller.enqueue(encoder.encode(encodeSseFrame(frame)));
    }
}

function enqueuePing(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder): void {
    controller.enqueue(encoder.encode(encodeSseFrame({ event: 'ping', data: { type: 'ping' } })));
}

async function nextEventOrKeepalive(
    pendingNext: Promise<IteratorResult<InternalAssistantEvent>>,
): Promise<IteratorResult<InternalAssistantEvent> | 'keepalive'> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const keepalive = new Promise<'keepalive'>((resolve) => {
        timeout = setTimeout(() => resolve('keepalive'), STREAM_KEEPALIVE_INTERVAL_MS);
    });
    try {
        return await Promise.race([pendingNext, keepalive]);
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

function enqueueError(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, error: ProxyError): void {
    controller.enqueue(
        encoder.encode(
            encodeSseFrame({
                event: 'error',
                data: toAnthropicErrorBody(error),
            }),
        ),
    );
}

async function readJsonBody(request: Request, maxBodyBytes: number): Promise<unknown> {
    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBodyBytes) {
        throw new ProxyError('Request body is too large.', { httpStatus: 413, errorType: 'request_too_large' });
    }

    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxBodyBytes) {
        throw new ProxyError('Request body is too large.', { httpStatus: 413, errorType: 'request_too_large' });
    }

    try {
        return JSON.parse(new TextDecoder().decode(buffer));
    } catch {
        throw new ProxyValidationError('Request body must be valid JSON.');
    }
}

function createModelsResponse() {
    return {
        data: CODEX_MODEL_CATALOG.map((model) => ({
            id: model.id,
            type: 'model',
            display_name: model.id,
            created_at: 0,
        })),
    };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        ...init,
        headers: {
            ...JSON_HEADERS,
            ...init?.headers,
        },
    });
}

function jsonError(error: ProxyError): Response {
    return jsonResponse(toAnthropicErrorBody(error), { status: error.httpStatus });
}

function normalizeError(error: unknown): ProxyError {
    if (isProxyError(error)) {
        return error;
    }
    if (error instanceof Error) {
        return new ProxyError(error.message || 'Internal proxy error.', { httpStatus: 500, errorType: 'api_error' });
    }
    return new ProxyError(String(error), { httpStatus: 500, errorType: 'api_error' });
}

function clampPromptCacheKey(value: string): string {
    return Array.from(value).slice(0, 64).join('');
}

async function traceDebugBody(config: ProxyRuntimeConfig, rawBody: unknown): Promise<void> {
    if (!config.debugBodiesPath) {
        return;
    }

    await appendFile(
        config.debugBodiesPath,
        `${JSON.stringify({
            at: new Date().toISOString(),
            body: redactBody(rawBody),
        })}\n`,
        'utf8',
    );
}

export function redactBody(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(redactBody);
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (/token|authorization|api[_-]?key|secret|password|signature|encrypted[_-]?content|thinking|data/i.test(key)) {
            result[key] = '[redacted]';
        } else {
            result[key] = redactBody(item);
        }
    }
    return result;
}

function logRequest(logger: ProxyLogger, startedAt: number, fields: Record<string, unknown>): void {
    logger.info({
        at: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        ...fields,
    });
}

const consoleLogger: ProxyLogger = {
    info(event) {
        console.info(JSON.stringify(event));
    },
    error(event) {
        console.error(JSON.stringify(event));
    },
};
