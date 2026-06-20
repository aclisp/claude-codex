import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectAnthropicMessage } from './anthropic/response.ts';
import { CodexAuthReader } from './codex/auth.ts';
import { CodexClient } from './codex/client.ts';
import { buildCodexRequest } from './codex/request.ts';
import { mapRawCodexEvents, processCodexStream } from './codex/stream.ts';
import { createProxyServer } from './http/server.ts';
import { loadRuntimeConfig } from './runtime/config.ts';
import { createSessionStore } from './sessions/store.ts';

describe('Codex auth reader', () => {
    test('reads file-backed Codex auth without requiring keyring access', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-auth-');
        const authPath = join(dir, 'auth.json');
        await writeFile(
            authPath,
            JSON.stringify({
                tokens: {
                    id_token: createJwt('acct_test'),
                },
            }),
        );

        const credentials = await new CodexAuthReader(authPath).read();
        expect(credentials.accountId).toBe('acct_test');
        expect(credentials.token).toContain('.');
        expect(credentials.authPath).toBe(authPath);
    });
});

describe('Codex stream processing', () => {
    test('maps raw Responses events to internal text events', async () => {
        const events = await collectAsync(
            processCodexStream(
                mapRawCodexEvents(
                    asyncIterable([
                        { type: 'response.created', response: { id: 'resp_1' } },
                        {
                            type: 'response.output_item.added',
                            output_index: 0,
                            item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
                        },
                        { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Hi' },
                        {
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: {
                                type: 'message',
                                id: 'msg_1',
                                role: 'assistant',
                                status: 'completed',
                                content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
                            },
                        },
                        {
                            type: 'response.completed',
                            response: {
                                id: 'resp_1',
                                status: 'completed',
                                output: [],
                                usage: {
                                    input_tokens: 2,
                                    input_tokens_details: { cached_tokens: 1 },
                                    output_tokens: 1,
                                    output_tokens_details: { reasoning_tokens: 0 },
                                    total_tokens: 3,
                                },
                            },
                        },
                    ]),
                ),
                { model: 'gpt-5.4-mini', messageId: 'msg_ccx_test', createdAt: 1 },
            ),
        );

        expect(collectAnthropicMessage(events)).toEqual({
            id: 'msg_ccx_test',
            type: 'message',
            role: 'assistant',
            model: 'gpt-5.4-mini',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: 2,
                output_tokens: 1,
                cache_read_input_tokens: 1,
            },
        });
    });

    test('maps function calls to encoded Anthropic tool ids', async () => {
        const events = await collectAsync(
            processCodexStream(
                mapRawCodexEvents(
                    asyncIterable([
                        { type: 'response.created', response: { id: 'resp_2' } },
                        {
                            type: 'response.output_item.added',
                            output_index: 0,
                            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' },
                        },
                        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"path":' },
                        { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', name: 'read_file', arguments: '{"path":"/tmp/a"}' },
                        {
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/tmp/a"}' },
                        },
                        { type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [] } },
                    ]),
                ),
                { model: 'gpt-5.4-mini', messageId: 'msg_ccx_tool', createdAt: 1 },
            ),
        );

        const message = collectAnthropicMessage(events);
        expect(message.stop_reason).toBe('tool_use');
        expect(message.content[0]).toMatchObject({
            type: 'tool_use',
            name: 'read_file',
            input: { path: '/tmp/a' },
        });
        expect((message.content[0] as { id: string }).id.startsWith('ccx_')).toBe(true);
    });
});

describe('HTTP proxy server', () => {
    test('serves static model catalog', async () => {
        const { server } = await createTestServer();
        const response = await server.fetch(new Request('http://127.0.0.1/v1/models'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            data: [
                { id: 'gpt-5.5', type: 'model', display_name: 'gpt-5.5', created_at: 0 },
                { id: 'gpt-5.4', type: 'model', display_name: 'gpt-5.4', created_at: 0 },
                { id: 'gpt-5.4-mini', type: 'model', display_name: 'gpt-5.4-mini', created_at: 0 },
            ],
        });
    });

    test('handles non-streaming /v1/messages using mocked SSE upstream', async () => {
        const { server } = await createTestServer();
        const response = await server.fetch(
            new Request('http://127.0.0.1/v1/messages', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-claude-session-id': 'session-a' },
                body: JSON.stringify({
                    model: 'gpt-5.4-mini',
                    max_tokens: 64,
                    messages: [{ role: 'user', content: 'hello' }],
                }),
            }),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            type: 'message',
            role: 'assistant',
            model: 'gpt-5.4-mini',
            content: [{ type: 'text', text: 'Hello from Codex' }],
            stop_reason: 'end_turn',
        });
    });
});

describe('Codex transport', () => {
    test('falls back to SSE when WebSocket fails before upstream events', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-fallback-');
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, JSON.stringify({ tokens: { id_token: createJwt('acct_test') } }));
        let fetchCalls = 0;
        const client = new CodexClient({
            baseUrl: 'https://chatgpt.com/backend-api',
            authReader: new CodexAuthReader(authPath),
            websocketConnectTimeoutMs: 50,
            upstreamIdleTimeoutMs: 0,
            WebSocketCtor: FailingWebSocket,
            fetchFn: async () => {
                fetchCalls += 1;
                return createSseResponse();
            },
        });
        const body = buildCodexRequest({
            model: 'gpt-5.4-mini',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hello' }],
        });

        const result = client.stream(body, { sessionId: 'session-fallback' });
        const events = await collectAsync(result.events);

        expect(fetchCalls).toBe(1);
        expect(collectAnthropicMessage(events).content).toEqual([{ type: 'text', text: 'Hello from Codex' }]);
    });
});

async function createTestServer() {
    const dir = await mkdtemp('/private/tmp/claude-codex-server-');
    const authPath = join(dir, 'auth.json');
    await writeFile(authPath, JSON.stringify({ tokens: { id_token: createJwt('acct_test') } }));
    const config = loadRuntimeConfig(['--auth-path', authPath, '--state-dir', join(dir, '.claude-codex')], { HOME: dir });
    const client = new CodexClient({
        baseUrl: config.codexBaseUrl,
        authReader: new CodexAuthReader(authPath),
        websocketConnectTimeoutMs: config.websocketConnectTimeoutMs,
        upstreamIdleTimeoutMs: config.upstreamIdleTimeoutMs,
        WebSocketCtor: null,
        fetchFn: async () => createSseResponse(),
    });
    return {
        server: createProxyServer(config, {
            codexClient: client,
            sessionStore: createSessionStore(config.stateDir),
            logger: {
                info() {},
                error() {},
            },
        }),
    };
}

function createSseResponse(): Response {
    const body = [
        { type: 'response.created', response: { id: 'resp_test' } },
        {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg_upstream', role: 'assistant', status: 'in_progress', content: [] },
        },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_upstream', content_index: 0, delta: 'Hello from Codex' },
        {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                type: 'message',
                id: 'msg_upstream',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Hello from Codex', annotations: [] }],
            },
        },
        {
            type: 'response.completed',
            response: {
                id: 'resp_test',
                status: 'completed',
                output: [],
                usage: {
                    input_tokens: 5,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens: 3,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 8,
                },
            },
        },
    ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('');

    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

function createJwt(accountId: string): string {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
    return `header.${payload}.signature`;
}

async function collectAsync<T>(events: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = [];
    for await (const event of events) {
        result.push(event);
    }
    return result;
}

async function* asyncIterable(events: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) {
        yield event;
    }
}

class FailingWebSocket {
    readyState = 0;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
        setTimeout(() => {
            this.emit('error', { message: 'connect failed' });
        }, 0);
    }

    send(): void {}

    close(): void {
        this.readyState = 3;
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}
