import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResponseReasoningItem } from 'openai/resources/responses/responses.js';
import { collectAnthropicMessage } from './anthropic/response.ts';
import { toAnthropicSseFrames } from './anthropic/sse.ts';
import { CodexAuthReader } from './codex/auth.ts';
import { CodexClient } from './codex/client.ts';
import { buildCodexRequest } from './codex/request.ts';
import { mapRawCodexEvents, processCodexStream } from './codex/stream.ts';
import { createProxyServer } from './http/server.ts';
import type { InternalAssistantEvent } from './protocol/events.ts';
import { decodeReasoningSignature } from './reasoning/signature.ts';
import { loadRuntimeConfig } from './runtime/config.ts';
import { createSessionStore, SESSION_STORE_MAX_RECORDS } from './sessions/store.ts';

describe('Codex auth reader', () => {
    test('reads file-backed Codex auth without requiring keyring access', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-auth-');
        const authPath = join(dir, 'auth.json');
        await writeFile(
            authPath,
            JSON.stringify({
                tokens: {
                    access_token: 'access_test',
                    account_id: 'acct_test',
                },
            }),
        );

        const credentials = await new CodexAuthReader(authPath).read();
        expect(credentials.accountId).toBe('acct_test');
        expect(credentials.token).toBe('access_test');
        expect(credentials.authPath).toBe(authPath);
    });
});

describe('Runtime config', () => {
    test('defaults Codex reasoning effort to medium', () => {
        expect(loadRuntimeConfig([], { HOME: '/tmp/test-home' }).defaultEffort).toBe('medium');
    });

    test('resolves upstream proxy from HTTPS proxy env', () => {
        const config = loadRuntimeConfig([], {
            HOME: '/tmp/test-home',
            https_proxy: 'http://127.0.0.1:7890',
            http_proxy: 'http://127.0.0.1:8888',
        });

        expect(config.upstreamProxyUrl).toBe('http://127.0.0.1:7890/');
    });

    test('honors no_proxy for upstream proxy env', () => {
        const config = loadRuntimeConfig([], {
            HOME: '/tmp/test-home',
            https_proxy: 'http://127.0.0.1:7890',
            no_proxy: 'chatgpt.com',
        });

        expect(config.upstreamProxyUrl).toBeUndefined();
    });
});

describe('Session store', () => {
    test('uses only the documented Claude Code session header', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-session-');
        const store = createSessionStore(join(dir, '.claude-codex'));

        const resolved = await store.resolve(
            new Headers({
                'x-claude-code-session-id': 'new-session',
                'x-claude-session-id': 'legacy-session',
            }),
        );

        expect(resolved.record.claudeHeader).toBe('new-session');
        expect(resolved.record.fingerprint).toBe('header:new-session');

        const legacyOnly = await store.resolve(
            new Headers({
                'x-claude-session-id': 'legacy-session',
                'x-claude-code-cwd': '/tmp/project',
                'user-agent': 'claude-code-test',
            }),
        );

        expect(legacyOnly.record.claudeHeader).toBeUndefined();
        expect(legacyOnly.record.fingerprint).toBe('fallback:/tmp/project:claude-code-test');
    });

    test('caps loaded and saved session records by recent use', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-session-cap-');
        const stateDir = join(dir, '.claude-codex');
        const sessionsPath = join(stateDir, 'sessions.json');
        await mkdir(stateDir, { recursive: true });
        const oversizedSessions = Array.from({ length: SESSION_STORE_MAX_RECORDS + 5 }, (_, index) => ({
            id: `ccx_${index}`,
            createdAt: index,
            lastSeenAt: index,
            fingerprint: `header:session-${index}`,
            claudeHeader: `session-${index}`,
        }));
        await writeFile(
            sessionsPath,
            `${JSON.stringify({
                version: 1,
                sessions: oversizedSessions,
            })}\n`,
        );

        const store = createSessionStore(stateDir);
        await store.resolve(new Headers({ 'x-claude-code-session-id': 'fresh-session' }));

        const persisted = JSON.parse(await readFile(sessionsPath, 'utf8')) as { sessions: Array<{ fingerprint: string }> };
        expect(persisted.sessions).toHaveLength(SESSION_STORE_MAX_RECORDS);
        expect(persisted.sessions[0]?.fingerprint).toBe('header:fresh-session');
        expect(persisted.sessions.some((record) => record.fingerprint === 'header:session-0')).toBe(false);
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
                input_tokens: 1,
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

    test('maps Codex reasoning summaries to Anthropic thinking blocks', async () => {
        const reasoningItem: ResponseReasoningItem = {
            type: 'reasoning',
            id: 'rs_1',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'Looked at the request.' }],
            encrypted_content: 'encrypted-reasoning',
        };
        const events = await collectAsync(
            processCodexStream(
                mapRawCodexEvents(
                    asyncIterable([
                        { type: 'response.created', response: { id: 'resp_3' } },
                        {
                            type: 'response.output_item.added',
                            output_index: 0,
                            item: { type: 'reasoning', id: 'rs_1', status: 'in_progress', summary: [] },
                        },
                        {
                            type: 'response.reasoning_summary_text.delta',
                            output_index: 0,
                            item_id: 'rs_1',
                            summary_index: 0,
                            delta: 'Looked at ',
                            sequence_number: 1,
                        },
                        {
                            type: 'response.reasoning_summary_text.done',
                            output_index: 0,
                            item_id: 'rs_1',
                            summary_index: 0,
                            text: 'Looked at the request.',
                            sequence_number: 2,
                        },
                        {
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: reasoningItem,
                        },
                        {
                            type: 'response.output_item.added',
                            output_index: 1,
                            item: { type: 'message', id: 'msg_3', role: 'assistant', status: 'in_progress', content: [] },
                        },
                        { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_3', content_index: 0, delta: 'Ready.' },
                        {
                            type: 'response.output_item.done',
                            output_index: 1,
                            item: {
                                type: 'message',
                                id: 'msg_3',
                                role: 'assistant',
                                status: 'completed',
                                content: [{ type: 'output_text', text: 'Ready.', annotations: [] }],
                            },
                        },
                        { type: 'response.completed', response: { id: 'resp_3', status: 'completed', output: [] } },
                    ]),
                ),
                { model: 'gpt-5.4-mini', messageId: 'msg_ccx_thinking', createdAt: 1 },
            ),
        );

        expect(events.map((event) => event.type)).toEqual([
            'message_start',
            'thinking_start',
            'thinking_delta',
            'thinking_delta',
            'thinking_signature_delta',
            'thinking_end',
            'text_start',
            'text_delta',
            'text_end',
            'message_end',
        ]);

        const message = collectAnthropicMessage(events);
        const thinking = message.content[0] as { type: 'thinking'; thinking: string; signature: string };
        expect(thinking).toMatchObject({
            type: 'thinking',
            thinking: 'Looked at the request.',
        });
        expect(decodeReasoningSignature(thinking.signature)).toEqual(reasoningItem);
        expect(message.content[1]).toEqual({ type: 'text', text: 'Ready.' });
    });

    test('maps encrypted-only Codex reasoning to omitted Anthropic thinking', async () => {
        const reasoningItem: ResponseReasoningItem = {
            type: 'reasoning',
            id: 'rs_encrypted',
            status: 'completed',
            summary: [],
            encrypted_content: 'encrypted-only',
        };
        const events = await collectAsync(
            processCodexStream(
                mapRawCodexEvents(
                    asyncIterable([
                        { type: 'response.created', response: { id: 'resp_4' } },
                        {
                            type: 'response.output_item.added',
                            output_index: 0,
                            item: { type: 'reasoning', id: 'rs_encrypted', status: 'in_progress', summary: [] },
                        },
                        {
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: reasoningItem,
                        },
                        { type: 'response.completed', response: { id: 'resp_4', status: 'completed', output: [] } },
                    ]),
                ),
                { model: 'gpt-5.4-mini', messageId: 'msg_ccx_omitted', createdAt: 1 },
            ),
        );

        expect(events.map((event) => event.type)).toEqual(['message_start', 'thinking_start', 'thinking_signature_delta', 'thinking_end', 'message_end']);
        const message = collectAnthropicMessage(events);
        const thinking = message.content[0] as { type: 'thinking'; thinking: string; signature: string };
        expect(thinking.thinking).toBe('');
        expect(decodeReasoningSignature(thinking.signature)).toEqual(reasoningItem);
        expect(toAnthropicSseFrames(events).filter((frame) => JSON.stringify(frame.data).includes('thinking_delta'))).toHaveLength(0);
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
                headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-a' },
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

    test('logs validation error details for rejected requests', async () => {
        const logs: Record<string, unknown>[] = [];
        const dir = await mkdtemp('/private/tmp/claude-codex-log-error-');
        const server = createProxyServer(loadRuntimeConfig(['--state-dir', join(dir, '.claude-codex')], { HOME: dir }), {
            codexClient: fakeCodexClient([]),
            logger: captureLogger(logs),
        });

        const response = await server.fetch(
            new Request('http://127.0.0.1/v1/messages', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-error' },
                body: JSON.stringify({
                    model: 'gpt-5.4-mini',
                    max_tokens: 64,
                    messages: [{ role: 'bad', content: 'hello' }],
                }),
            }),
        );

        expect(response.status).toBe(400);
        expect(logs.at(-1)).toMatchObject({
            route: '/v1/messages',
            status: 400,
            error: 400,
            errorType: 'invalid_request_error',
            errorMessage: 'Unsupported message role "bad".',
        });
        expect((logs.at(-1) as { sessionId?: string }).sessionId?.startsWith('ccx_')).toBe(true);
    });

    test('logs session context for streaming setup errors', async () => {
        const logs: Record<string, unknown>[] = [];
        const dir = await mkdtemp('/private/tmp/claude-codex-stream-error-');
        const server = createProxyServer(loadRuntimeConfig(['--state-dir', join(dir, '.claude-codex')], { HOME: dir }), {
            codexClient: throwingCodexClient(new Error('upstream unavailable')),
            logger: captureLogger(logs),
        });

        const response = await server.fetch(
            new Request('http://127.0.0.1/v1/messages', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-stream-error' },
                body: JSON.stringify({
                    model: 'gpt-5.4-mini',
                    max_tokens: 64,
                    stream: true,
                    messages: [{ role: 'user', content: 'hello' }],
                }),
            }),
        );

        expect(response.status).toBe(500);
        expect(logs.at(-1)).toMatchObject({
            route: '/v1/messages',
            status: 500,
            error: 500,
            errorType: 'api_error',
            errorMessage: 'upstream unavailable',
        });
        expect((logs.at(-1) as { sessionId?: string }).sessionId?.startsWith('ccx_')).toBe(true);
    });

    test('handles /v1/messages/count_tokens without max_tokens', async () => {
        const { server } = await createTestServer();
        const response = await server.fetch(
            new Request('http://127.0.0.1/v1/messages/count_tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-5.4-mini',
                    system: 'Be concise.',
                    tools: [
                        {
                            name: 'lookup',
                            description: 'Look up a value',
                            input_schema: {
                                type: 'object',
                                properties: { key: { type: 'string' } },
                            },
                        },
                    ],
                    tool_choice: { type: 'tool', name: 'lookup' },
                    output_config: {
                        format: {
                            type: 'json_schema',
                            schema: {
                                type: 'object',
                                properties: { value: { type: 'string' } },
                            },
                        },
                    },
                    messages: [{ role: 'user', content: 'hello' }],
                }),
            }),
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as { input_tokens: number };
        expect(body.input_tokens).toBeGreaterThan(0);
    });

    test('logs session context for /v1/messages/count_tokens', async () => {
        const logs: Record<string, unknown>[] = [];
        const dir = await mkdtemp('/private/tmp/claude-codex-count-log-');
        const server = createProxyServer(loadRuntimeConfig(['--state-dir', join(dir, '.claude-codex')], { HOME: dir }), {
            codexClient: fakeCodexClient([]),
            logger: captureLogger(logs),
        });

        const response = await server.fetch(
            new Request('http://127.0.0.1/v1/messages/count_tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-count' },
                body: JSON.stringify({
                    model: 'gpt-5.4-mini',
                    messages: [{ role: 'user', content: 'hello' }],
                }),
            }),
        );

        expect(response.status).toBe(200);
        expect(logs.at(-1)).toMatchObject({
            route: '/v1/messages/count_tokens',
            status: 200,
        });
        expect((logs.at(-1) as { sessionId?: string }).sessionId?.startsWith('ccx_')).toBe(true);
    });

    test('streams Anthropic ping frames after message_start', async () => {
        const { server } = await createTestServer();
        const response = await server.fetch(
            new Request('http://127.0.0.1/v1/messages', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-stream' },
                body: JSON.stringify({
                    model: 'gpt-5.4-mini',
                    max_tokens: 64,
                    stream: true,
                    messages: [{ role: 'user', content: 'hello' }],
                }),
            }),
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toContain('event: ping');
    });
});

describe('Codex transport', () => {
    test('falls back to SSE when WebSocket fails before upstream events', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-fallback-');
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'access_test', account_id: 'acct_test' } }));
        let fetchCalls = 0;
        const fallbackEvents: unknown[] = [];
        const client = new CodexClient({
            baseUrl: 'https://chatgpt.com/backend-api',
            authReader: new CodexAuthReader(authPath),
            websocketConnectTimeoutMs: 50,
            upstreamIdleTimeoutMs: 0,
            WebSocketCtor: FailingWebSocket,
            websocketFallbackInitialCooldownMs: 60_000,
            fetchFn: async () => {
                fetchCalls += 1;
                return createSseResponse();
            },
            onTransportFallback(event) {
                fallbackEvents.push(event);
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
        expect(fallbackEvents).toEqual([
            {
                sessionId: 'session-fallback',
                from: 'websocket',
                to: 'sse',
                reason: 'connect failed',
            },
        ]);
    });

    test('uses SSE during WebSocket fallback cooldown', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-fallback-cooldown-');
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'access_test', account_id: 'acct_test' } }));
        RecoveringWebSocket.reset(['fail-connect']);
        let fetchCalls = 0;
        const client = new CodexClient({
            baseUrl: 'https://chatgpt.com/backend-api',
            authReader: new CodexAuthReader(authPath),
            websocketConnectTimeoutMs: 50,
            upstreamIdleTimeoutMs: 0,
            WebSocketCtor: RecoveringWebSocket,
            websocketFallbackInitialCooldownMs: 60_000,
            nowFn: () => 0,
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

        await collectAsync(client.stream(body, { sessionId: 'session-cooldown' }).events);
        const second = client.stream(body, { sessionId: 'session-cooldown' });
        await collectAsync(second.events);

        expect(second.transport).toBe('sse');
        expect(fetchCalls).toBe(2);
        expect(RecoveringWebSocket.connectCount).toBe(1);
    });

    test('retries WebSocket after fallback cooldown expires', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-fallback-retry-');
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'access_test', account_id: 'acct_test' } }));
        let now = 0;
        let fetchCalls = 0;
        RecoveringWebSocket.reset(['fail-connect', 'success']);
        const client = new CodexClient({
            baseUrl: 'https://chatgpt.com/backend-api',
            authReader: new CodexAuthReader(authPath),
            websocketConnectTimeoutMs: 50,
            upstreamIdleTimeoutMs: 0,
            WebSocketCtor: RecoveringWebSocket,
            websocketFallbackInitialCooldownMs: 1_000,
            nowFn: () => now,
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

        await collectAsync(client.stream(body, { sessionId: 'session-retry' }).events);
        now = 1_001;
        const retry = client.stream(body, { sessionId: 'session-retry' });
        const retryEvents = await collectAsync(retry.events);

        expect(retry.transport).toBe('websocket');
        expect(fetchCalls).toBe(1);
        expect(RecoveringWebSocket.connectCount).toBe(2);
        expect(collectAnthropicMessage(retryEvents).content).toEqual([{ type: 'text', text: 'Hello from WebSocket' }]);
    });

    test('does not replay through SSE when WebSocket fails after upstream events', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-fallback-partial-');
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'access_test', account_id: 'acct_test' } }));
        const fallbackEvents: unknown[] = [];
        let fetchCalls = 0;
        RecoveringWebSocket.reset(['partial-error']);
        const client = new CodexClient({
            baseUrl: 'https://chatgpt.com/backend-api',
            authReader: new CodexAuthReader(authPath),
            websocketConnectTimeoutMs: 50,
            upstreamIdleTimeoutMs: 0,
            WebSocketCtor: RecoveringWebSocket,
            websocketFallbackInitialCooldownMs: 60_000,
            nowFn: () => 0,
            fetchFn: async () => {
                fetchCalls += 1;
                return createSseResponse();
            },
            onTransportFallback(event) {
                fallbackEvents.push(event);
            },
        });
        const body = buildCodexRequest({
            model: 'gpt-5.4-mini',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hello' }],
        });

        await expect(collectAsync(client.stream(body, { sessionId: 'session-partial' }).events)).rejects.toThrow('stream interrupted');
        const next = client.stream(body, { sessionId: 'session-partial' });
        await collectAsync(next.events);

        expect(next.transport).toBe('sse');
        expect(fetchCalls).toBe(1);
        expect(fallbackEvents).toEqual([
            {
                sessionId: 'session-partial',
                from: 'websocket',
                to: 'sse',
                reason: 'stream interrupted',
            },
        ]);
    });

    test('passes Bun proxy option to SSE fetch', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-fetch-proxy-');
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'access_test', account_id: 'acct_test' } }));
        let capturedInit: RequestInit | undefined;
        const client = new CodexClient({
            baseUrl: 'https://chatgpt.com/backend-api',
            upstreamProxyUrl: 'http://127.0.0.1:7890/',
            authReader: new CodexAuthReader(authPath),
            websocketConnectTimeoutMs: 50,
            upstreamIdleTimeoutMs: 0,
            WebSocketCtor: null,
            fetchFn: async (_input, init) => {
                capturedInit = init;
                return createSseResponse();
            },
        });
        const body = buildCodexRequest({
            model: 'gpt-5.4-mini',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hello' }],
        });

        await collectAsync(client.stream(body, { sessionId: 'session-fetch-proxy' }).events);

        expect((capturedInit as { proxy?: string }).proxy).toBe('http://127.0.0.1:7890/');
    });

    test('passes Bun proxy option to WebSocket constructor before SSE fallback', async () => {
        const dir = await mkdtemp('/private/tmp/claude-codex-ws-proxy-');
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'access_test', account_id: 'acct_test' } }));
        FailingWebSocket.lastOptions = undefined;
        const client = new CodexClient({
            baseUrl: 'https://chatgpt.com/backend-api',
            upstreamProxyUrl: 'http://127.0.0.1:7890/',
            authReader: new CodexAuthReader(authPath),
            websocketConnectTimeoutMs: 50,
            upstreamIdleTimeoutMs: 0,
            WebSocketCtor: FailingWebSocket,
            fetchFn: async () => createSseResponse(),
        });
        const body = buildCodexRequest({
            model: 'gpt-5.4-mini',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hello' }],
        });

        await collectAsync(client.stream(body, { sessionId: 'session-ws-proxy' }).events);

        expect((FailingWebSocket.lastOptions as { proxy?: string }).proxy).toBe('http://127.0.0.1:7890/');
    });
});

async function createTestServer() {
    const dir = await mkdtemp('/private/tmp/claude-codex-server-');
    const authPath = join(dir, 'auth.json');
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'access_test', account_id: 'acct_test' } }));
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
                warn() {},
                error() {},
            },
        }),
    };
}

function createTextResponseEvents(text: string, suffix: string): Record<string, unknown>[] {
    return [
        { type: 'response.created', response: { id: `resp_${suffix}` } },
        {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: `msg_${suffix}`, role: 'assistant', status: 'in_progress', content: [] },
        },
        { type: 'response.output_text.delta', output_index: 0, item_id: `msg_${suffix}`, content_index: 0, delta: text },
        {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                type: 'message',
                id: `msg_${suffix}`,
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }],
            },
        },
        {
            type: 'response.completed',
            response: {
                id: `resp_${suffix}`,
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
    ];
}

function createSseResponse(): Response {
    const body = createTextResponseEvents('Hello from Codex', 'test')
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('');

    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

async function collectAsync<T>(events: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = [];
    for await (const event of events) {
        result.push(event);
    }
    return result;
}

function fakeCodexClient(events: InternalAssistantEvent[]) {
    return {
        stream() {
            return {
                transport: 'sse' as const,
                events: asyncInternalIterable(events),
            };
        },
    } as unknown as CodexClient;
}

function throwingCodexClient(error: Error) {
    return {
        stream() {
            return {
                transport: 'sse' as const,
                events: createThrowingInternalIterable(error),
            };
        },
    } as unknown as CodexClient;
}

function captureLogger(logs: Record<string, unknown>[]) {
    return {
        info(event: Record<string, unknown>) {
            logs.push(event);
        },
        warn(event: Record<string, unknown>) {
            logs.push(event);
        },
        error(event: Record<string, unknown>) {
            logs.push(event);
        },
    };
}

async function* asyncIterable(events: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) {
        yield event;
    }
}

async function* asyncInternalIterable(events: InternalAssistantEvent[]): AsyncGenerator<InternalAssistantEvent> {
    for (const event of events) {
        yield event;
    }
}

function createThrowingInternalIterable(error: Error): AsyncIterable<InternalAssistantEvent> {
    return {
        [Symbol.asyncIterator]() {
            return {
                async next(): Promise<IteratorResult<InternalAssistantEvent>> {
                    throw error;
                },
            };
        },
    };
}

class FailingWebSocket {
    static lastOptions: unknown;

    readyState = 0;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(_url?: string, options?: unknown) {
        FailingWebSocket.lastOptions = options;
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

type RecoveringWebSocketOutcome = 'fail-connect' | 'success' | 'partial-error';

class RecoveringWebSocket {
    static connectCount = 0;
    private static outcomes: RecoveringWebSocketOutcome[] = [];

    readyState = 0;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
    private readonly outcome: RecoveringWebSocketOutcome;

    static reset(outcomes: RecoveringWebSocketOutcome[]): void {
        RecoveringWebSocket.connectCount = 0;
        RecoveringWebSocket.outcomes = [...outcomes];
    }

    constructor() {
        RecoveringWebSocket.connectCount += 1;
        this.outcome = RecoveringWebSocket.outcomes.shift() ?? 'success';
        setTimeout(() => {
            if (this.outcome === 'fail-connect') {
                this.readyState = 3;
                this.emit('error', { message: 'connect failed' });
                return;
            }
            this.readyState = 1;
            this.emit('open', {});
        }, 0);
    }

    send(): void {
        setTimeout(() => {
            if (this.outcome === 'partial-error') {
                this.emit('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'resp_partial' } }) });
                this.emit('error', { message: 'stream interrupted' });
                return;
            }
            for (const event of createTextResponseEvents('Hello from WebSocket', 'ws')) {
                this.emit('message', { data: JSON.stringify(event) });
            }
        }, 0);
    }

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
