import { appendFile } from 'node:fs/promises';
import { parseAnthropicRequest } from '../anthropic/request.ts';
import { collectAnthropicMessage } from '../anthropic/response.ts';
import { encodeSseFrame, toAnthropicSseFrames } from '../anthropic/sse.ts';
import type { CodexClient, CodexUpstreamRequestDiagnostic } from '../codex/client.ts';
import { countTranslatedTokens } from '../codex/count-tokens.ts';
import { CODEX_MODEL_CATALOG } from '../codex/models.ts';
import { buildCodexRequest } from '../codex/request.ts';
import { formatLogEvent } from '../logging.ts';
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
    warn(event: Record<string, unknown>): void;
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
            const logContext: Record<string, unknown> = {};

            try {
                if (request.method === 'GET' && url.pathname === '/v1/models') {
                    const response = jsonResponse(createModelsResponse());
                    logRequest(logger, startedAt, { route: url.pathname, status: response.status });
                    return response;
                }

                if (request.method === 'POST' && url.pathname === '/v1/messages') {
                    const session = await sessionStore.resolve(request.headers);
                    logContext.sessionId = session.sessionId;
                    const response = await handleMessages(request, config, dependencies.codexClient, session.sessionId, logger, startedAt);
                    return response;
                }

                if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
                    const session = await sessionStore.resolve(request.headers);
                    logContext.sessionId = session.sessionId;
                    const response = await handleCountTokens(request, config, logger, startedAt, session.sessionId);
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
                    ...logContext,
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
    sessionId: string,
    logger: ProxyLogger,
    startedAt: number,
): Promise<Response> {
    const rawBody = await readJsonBody(request, config.maxBodyBytes);
    await traceDebugBody(config, rawBody);

    const anthropicRequest = parseAnthropicRequest(rawBody);
    const codexBody = buildCodexRequest(anthropicRequest, {
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        promptCacheKey: clampPromptCacheKey(sessionId),
        textVerbosity: config.textVerbosity,
    });
    const translatedInputTokens = countTranslatedTokens(codexBody);
    let upstreamRequestDiagnostic: CodexUpstreamRequestDiagnostic | undefined;

    const abortController = new AbortController();
    const result = codexClient.stream(codexBody, {
        sessionId,
        signal: abortController.signal,
        onUpstreamRequest: (diagnostic) => {
            upstreamRequestDiagnostic = diagnostic;
        },
    });

    if (anthropicRequest.stream === true) {
        const response = await createStreamingResponse(
            result.events,
            abortController,
            logger,
            startedAt,
            {
                route: '/v1/messages',
                model: codexBody.model,
                sessionId,
                transport: result.transport,
            },
            translatedInputTokens,
            () => upstreamRequestDiagnostic,
            config.tokenDiagnostics,
        );
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
        sessionId,
        transport: result.transport,
        status: 200,
        stopReason: message.stop_reason,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens,
        ...tokenDiagnostic({
            inputTokens: message.usage.input_tokens,
            cacheReadInputTokens: message.usage.cache_read_input_tokens,
            webSearchRequests: message.usage.server_tool_use?.web_search_requests,
            translatedInputTokens,
            upstreamRequestDiagnostic,
            mode: config.tokenDiagnostics,
        }),
    });
    return jsonResponse(message);
}

async function handleCountTokens(request: Request, config: ProxyRuntimeConfig, logger: ProxyLogger, startedAt: number, sessionId: string): Promise<Response> {
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
        sessionId,
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
    translatedInputTokens?: number,
    upstreamRequestDiagnostic?: () => CodexUpstreamRequestDiagnostic | undefined,
    tokenDiagnostics: ProxyRuntimeConfig['tokenDiagnostics'] = 'threshold',
): Promise<Response> {
    const iterator = events[Symbol.asyncIterator]();
    let first: IteratorResult<InternalAssistantEvent>;
    try {
        first = await iterator.next();
    } catch (error) {
        const normalized = normalizeError(error);
        const response = jsonError(normalized);
        logRequest(logger, startedAt, {
            ...logFields,
            status: response.status,
            error: response.status,
            errorType: normalized.errorType,
            errorMessage: normalized.message,
        });
        return response;
    }

    if (first.done) {
        const error = new ProxyError('Codex stream ended before producing a message.', { httpStatus: 502, errorType: 'api_error' });
        const response = jsonError(error);
        logRequest(logger, startedAt, {
            ...logFields,
            status: response.status,
            error: response.status,
            errorType: error.errorType,
            errorMessage: error.message,
        });
        return response;
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let status = 200;
            let stopReason: string | undefined;
            let inputTokens: number | undefined;
            let outputTokens: number | undefined;
            let cacheReadInputTokens: number | undefined;
            let webSearchRequests: number | undefined;
            let errorType: string | undefined;
            let errorMessage: string | undefined;
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
                        webSearchRequests = event.usage?.webSearchRequests;
                    }
                    enqueueEvent(controller, encoder, event);
                }
            } catch (error) {
                const normalized = normalizeError(error);
                status = normalized.httpStatus;
                errorType = normalized.errorType;
                errorMessage = normalized.message;
                enqueueError(controller, encoder, normalized);
            } finally {
                logRequest(logger, startedAt, {
                    ...logFields,
                    status,
                    error: status >= 400 ? status : undefined,
                    errorType,
                    errorMessage,
                    stopReason,
                    inputTokens,
                    outputTokens,
                    cacheReadInputTokens,
                    ...tokenDiagnostic({
                        inputTokens,
                        cacheReadInputTokens,
                        webSearchRequests,
                        translatedInputTokens,
                        upstreamRequestDiagnostic: upstreamRequestDiagnostic?.(),
                        mode: tokenDiagnostics,
                    }),
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

function tokenDiagnostic(fields: {
    inputTokens?: number;
    cacheReadInputTokens?: number;
    webSearchRequests?: number;
    translatedInputTokens?: number;
    upstreamRequestDiagnostic?: CodexUpstreamRequestDiagnostic;
    mode: ProxyRuntimeConfig['tokenDiagnostics'];
}): Record<string, unknown> {
    if (fields.mode === 'off') {
        return {};
    }
    const needsDiagnostic =
        fields.mode === 'all' ||
        (fields.webSearchRequests !== undefined && fields.webSearchRequests > 0) ||
        (fields.inputTokens !== undefined && fields.inputTokens >= 10_000) ||
        (fields.inputTokens !== undefined && fields.inputTokens >= 5_000 && fields.cacheReadInputTokens === 0);
    if (!needsDiagnostic || fields.translatedInputTokens === undefined) {
        return {};
    }
    const diagnostic: Record<string, unknown> = {
        translatedInputTokens: fields.translatedInputTokens,
    };
    if (fields.upstreamRequestDiagnostic !== undefined) {
        diagnostic.sentInputTokens = fields.upstreamRequestDiagnostic.sentInputTokens;
        diagnostic.sentInputItems = fields.upstreamRequestDiagnostic.sentInputItems;
        if (fields.upstreamRequestDiagnostic.websocketContinuation !== undefined) {
            diagnostic.websocketContinuation = fields.upstreamRequestDiagnostic.websocketContinuation;
        }
    }
    if (fields.webSearchRequests !== undefined && fields.webSearchRequests > 0) {
        diagnostic.webSearchRequests = fields.webSearchRequests;
    }
    return diagnostic;
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
    const event: Record<string, unknown> = {
        at: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        ...fields,
    };
    const status = typeof event.status === 'number' ? event.status : undefined;
    if (status !== undefined && status >= 500) {
        logger.error(event);
        return;
    }
    if (status !== undefined && status >= 400) {
        logger.warn(event);
        return;
    }
    if (event.error !== undefined) {
        logger.error(event);
        return;
    }
    logger.info(event);
}

const consoleLogger: ProxyLogger = {
    info(event) {
        console.info(formatLogEvent('info', event));
    },
    warn(event) {
        console.warn(formatLogEvent('warn', event));
    },
    error(event) {
        console.error(formatLogEvent('error', event));
    },
};
