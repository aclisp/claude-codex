import { describe, expect, test } from 'bun:test';
import { collectAnthropicMessage } from './anthropic/response.ts';
import { encodeAnthropicSse, toAnthropicSseFrames } from './anthropic/sse.ts';
import { countTranslatedTokens } from './codex/count-tokens.ts';
import { translateAnthropicToCodex } from './codex/request.ts';
import { mapRawCodexEvents, processCodexStream } from './codex/stream.ts';
import { redactBody } from './http/server.ts';
import { ProxyValidationError } from './protocol/errors.ts';
import type { InternalAssistantEvent } from './protocol/events.ts';
import { encodeReasoningSignature } from './reasoning/signature.ts';
import { encodeToolId } from './tools/tool-id.ts';

describe('Anthropic to Codex request translation', () => {
    test('translates a text-only request', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 512,
            system: 'Be concise.',
            messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(body).toMatchObject({
            model: 'gpt-5.4-mini',
            store: false,
            stream: true,
            instructions: 'Be concise.',
            tool_choice: 'auto',
            parallel_tool_calls: true,
            text: { verbosity: 'low' },
            reasoning: { effort: 'medium', summary: 'auto' },
        });
        expect(body.input).toEqual([
            {
                role: 'user',
                content: [{ type: 'input_text', text: 'Hello' }],
            },
        ]);
    });

    test('ignores Claude-side context management controls', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            context_management: {
                edits: [
                    {
                        type: 'clear_tool_uses_20250919',
                        trigger: { type: 'input_tokens', value: 100_000 },
                        keep: { type: 'tool_uses', value: 3 },
                    },
                ],
            },
            messages: [{ role: 'user', content: 'x' }],
        });

        expect(body.input).toEqual([
            {
                role: 'user',
                content: [{ type: 'input_text', text: 'x' }],
            },
        ]);
    });

    test('translates system strings and text block arrays', () => {
        expect(
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                system: 'plain',
                messages: [{ role: 'user', content: 'x' }],
            }).instructions,
        ).toBe('plain');

        expect(
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                system: [
                    { type: 'text', text: 'first', cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: 'second' },
                ],
                messages: [{ role: 'user', content: 'x' }],
            }).instructions,
        ).toBe('first\n\nsecond');
    });

    test('translates system-role messages as developer input', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            system: 'top-level',
            messages: [
                { role: 'system', content: 'message-level' },
                { role: 'user', content: 'x' },
                {
                    role: 'system',
                    content: [
                        { type: 'text', text: 'block one' },
                        { type: 'text', text: 'block two' },
                    ],
                },
            ],
        });

        expect(body.instructions).toBe('top-level');
        expect(body.input).toEqual([
            {
                role: 'developer',
                content: [{ type: 'input_text', text: 'message-level' }],
            },
            {
                role: 'user',
                content: [{ type: 'input_text', text: 'x' }],
            },
            {
                role: 'developer',
                content: [{ type: 'input_text', text: 'block one\n\nblock two' }],
            },
        ]);
    });

    test('translates base64 user images to Responses data URLs', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'inspect' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
                    ],
                },
            ],
        });

        expect(body.input).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'inspect' },
                    { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aW1n' },
                ],
            },
        ]);
    });

    test('translates user image URLs to Responses image URLs', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'inspect' },
                        { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
                    ],
                },
            ],
        });

        expect(body.input).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'inspect' },
                    { type: 'input_image', detail: 'auto', image_url: 'https://example.com/cat.png' },
                ],
            },
        ]);
    });

    test('translates tool definitions to non-strict OpenAI function tools', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            tool_choice: { type: 'any' },
            tools: [
                {
                    name: 'read_file',
                    description: 'Read a file',
                    input_schema: {
                        type: 'object',
                        properties: { path: { type: 'string' } },
                        required: ['path'],
                    },
                    cache_control: { type: 'ephemeral' },
                },
            ],
            messages: [{ role: 'user', content: 'read' }],
        });

        expect(body.tool_choice).toBe('required');
        expect(body.tools).toEqual([
            {
                type: 'function',
                name: 'read_file',
                description: 'Read a file',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
                strict: null,
            },
        ]);
    });

    test('normalizes missing or malformed tool input schemas', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            tools: [{ name: 'missing_schema' }, { name: 'null_schema', input_schema: null }, { name: 'string_schema', input_schema: 'bad' }],
            messages: [{ role: 'user', content: 'use tools' }],
        });

        expect(body.tools).toEqual([
            {
                type: 'function',
                name: 'missing_schema',
                parameters: { type: 'object', properties: {} },
                strict: null,
            },
            {
                type: 'function',
                name: 'null_schema',
                parameters: { type: 'object', properties: {} },
                strict: null,
            },
            {
                type: 'function',
                name: 'string_schema',
                parameters: { type: 'object', properties: {} },
                strict: null,
            },
        ]);
    });

    test('translates basic hosted web search tools to OpenAI web_search', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            tools: [
                {
                    type: 'web_search_20250305',
                    name: 'web_search',
                    max_uses: 3,
                    allowed_domains: ['openai.com'],
                    blocked_domains: ['example.com'],
                    user_location: {
                        type: 'approximate',
                        city: 'San Francisco',
                        region: 'California',
                        country: 'US',
                        timezone: 'America/Los_Angeles',
                    },
                },
            ],
            messages: [{ role: 'user', content: 'search' }],
        });

        expect(body.tools as unknown).toEqual([
            {
                type: 'web_search',
                external_web_access: false,
                search_content_types: ['text', 'image'],
                filters: {
                    allowed_domains: ['openai.com'],
                    blocked_domains: ['example.com'],
                },
                user_location: {
                    type: 'approximate',
                    city: 'San Francisco',
                    region: 'California',
                    country: 'US',
                    timezone: 'America/Los_Angeles',
                },
            },
        ]);
        expect(JSON.stringify(body.tools)).not.toContain('max_uses');
        expect(countTranslatedTokens(body)).toBeGreaterThan(0);
    });

    test('translates named web search tool choice to required hosted tool choice', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            tool_choice: { type: 'tool', name: 'web_search' },
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: 'search' }],
        });

        expect(body.tool_choice).toEqual({
            type: 'web_search',
        });
    });

    test('rejects unsupported hosted web search variants', () => {
        expect(() =>
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                tools: [{ type: 'web_search_20260318', name: 'web_search' }],
                messages: [{ role: 'user', content: 'search' }],
            }),
        ).toThrow('Unsupported hosted web search tool type "web_search_20260318". Only web_search_20250305 is supported.');
    });

    test('translates named tool choice to forced OpenAI function choice', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            tool_choice: { type: 'tool', name: 'read_file' },
            tools: [
                {
                    name: 'read_file',
                    description: 'Read a file',
                    input_schema: {
                        type: 'object',
                        properties: { path: { type: 'string' } },
                        required: ['path'],
                    },
                },
            ],
            messages: [{ role: 'user', content: 'read' }],
        });

        expect(body.tool_choice).toEqual({ type: 'function', name: 'read_file' });
        expect(body.parallel_tool_calls).toBe(true);
    });

    test('disables parallel tool calls when requested by Anthropic tool_choice', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            tool_choice: { type: 'tool', name: 'read_file', disable_parallel_tool_use: true },
            tools: [
                {
                    name: 'read_file',
                    description: 'Read a file',
                    input_schema: {
                        type: 'object',
                        properties: { path: { type: 'string' } },
                        required: ['path'],
                    },
                },
            ],
            messages: [{ role: 'user', content: 'read' }],
        });

        expect(body.tool_choice).toEqual({ type: 'function', name: 'read_file' });
        expect(body.parallel_tool_calls).toBe(false);
    });

    test('replays assistant tool calls using encoded proxy ids', () => {
        const toolId = encodeToolId({ call: 'call_123', item: 'fc_123' });
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: toolId, name: 'read_file', input: { path: '/tmp/a' } }],
                },
            ],
        });

        expect(body.input).toEqual([
            {
                type: 'function_call',
                id: 'fc_123',
                call_id: 'call_123',
                name: 'read_file',
                arguments: JSON.stringify({ path: '/tmp/a' }),
            },
        ]);
    });

    test('replays assistant thinking blocks using proxy reasoning signatures', () => {
        const reasoningItem = {
            type: 'reasoning' as const,
            id: 'rs_123',
            summary: [{ type: 'summary_text' as const, text: 'Inspected the state.' }],
            encrypted_content: 'encrypted-reasoning',
            status: 'completed' as const,
        };
        const signature = encodeReasoningSignature(reasoningItem);

        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Inspected the state.', signature },
                        { type: 'text', text: 'Done.' },
                    ],
                },
            ],
        });

        expect(body.input).toEqual([
            reasoningItem,
            {
                type: 'message',
                role: 'assistant',
                id: 'msg_ccx_replay_0_1',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
            },
        ]);
    });

    test('replays proxy-owned redacted thinking data and rejects unknown reasoning signatures', () => {
        const reasoningItem = {
            type: 'reasoning' as const,
            id: 'rs_redacted',
            summary: [],
            encrypted_content: 'encrypted-only',
        };
        const signature = encodeReasoningSignature(reasoningItem);

        expect(
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: signature }] }],
            }).input,
        ).toEqual([reasoningItem]);

        expect(() =>
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'external', signature: 'not_proxy_owned' }] }],
            }),
        ).toThrow(ProxyValidationError);
    });

    test('maps tool results back to function_call_output items', () => {
        const toolId = encodeToolId({ call: 'call_456', item: 'fc_456' });
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: toolId,
                            content: [
                                { type: 'text', text: 'line 1' },
                                { type: 'text', text: 'line 2' },
                            ],
                        },
                    ],
                },
            ],
        });

        expect(body.input).toEqual([
            {
                type: 'function_call_output',
                call_id: 'call_456',
                output: 'line 1\nline 2',
            },
        ]);
    });

    test('stringifies unsupported tool result content blocks without throwing', () => {
        const toolId = encodeToolId({ call: 'call_unsupported', item: 'fc_unsupported' });
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: toolId,
                            content: [
                                { type: 'text', text: 'visible output' },
                                { type: 'thinking', thinking: 'hidden thought' },
                            ],
                        },
                    ],
                },
            ],
        });

        expect(body.input).toEqual([
            {
                type: 'function_call_output',
                call_id: 'call_unsupported',
                output: 'visible output\n[unsupported content block omitted: thinking]',
            },
        ]);
        expect(countTranslatedTokens(body)).toBeGreaterThan(0);
    });

    test('omits tool result images and malformed blocks with stable markers', () => {
        const toolId = encodeToolId({ call: 'call_images', item: 'fc_images' });
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: toolId,
                            content: [
                                { type: 'text' },
                                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
                                { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
                                { type: 'image' },
                            ],
                        },
                    ],
                },
            ],
        });

        expect(body.input).toEqual([
            {
                type: 'function_call_output',
                call_id: 'call_images',
                output: '[unsupported content block omitted: text]\n[image omitted: image/png]\n[image omitted: url]\n[unsupported content block omitted: image]',
            },
        ]);
    });

    test('drops replayed hosted web search server blocks', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'latest news' } },
                        {
                            type: 'web_search_tool_result',
                            tool_use_id: 'srvtoolu_1',
                            content: [{ type: 'web_search_result', title: 'Example', url: 'https://example.com' }],
                        },
                        { type: 'text', text: 'Result summary.' },
                    ],
                },
            ],
        });

        expect(body.input).toEqual([
            {
                type: 'message',
                role: 'assistant',
                id: 'msg_ccx_replay_0_2',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Result summary.', annotations: [] }],
            },
        ]);
    });

    test('rejects malformed proxy tool ids', () => {
        expect(() =>
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_not_proxy', content: 'nope' }],
                    },
                ],
            }),
        ).toThrow(ProxyValidationError);
    });

    test('resolves reasoning effort with output_config, thinking, then proxy default precedence', () => {
        expect(
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                output_config: { effort: 'low' },
                thinking: { type: 'disabled' },
                messages: [{ role: 'user', content: 'x' }],
            }).reasoning?.effort,
        ).toBe('low');

        expect(
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                thinking: { type: 'disabled' },
                messages: [{ role: 'user', content: 'x' }],
            }).reasoning?.effort,
        ).toBe('none');

        expect(
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                thinking: { type: 'adaptive' },
                messages: [{ role: 'user', content: 'x' }],
            }).reasoning?.effort,
        ).toBe('medium');

        expect(
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                thinking: { type: 'adaptive', budget_tokens: 2_000 },
                messages: [{ role: 'user', content: 'x' }],
            }).reasoning?.effort,
        ).toBe('low');

        expect(
            translateAnthropicToCodex(
                {
                    model: 'gpt-5.4-mini',
                    max_tokens: 128,
                    messages: [{ role: 'user', content: 'x' }],
                },
                { defaultEffort: 'medium' },
            ).reasoning?.effort,
        ).toBe('medium');
    });

    test('translates output_config.format to Responses structured text format', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            output_config: {
                format: {
                    type: 'json_schema',
                    name: 'answer_format',
                    schema: {
                        type: 'object',
                        properties: {
                            answer: { type: 'string' },
                        },
                    },
                },
            },
            messages: [{ role: 'user', content: 'return json' }],
        });

        expect(body.text.format).toEqual({
            type: 'json_schema',
            name: 'answer_format',
            schema: {
                type: 'object',
                properties: {
                    answer: { type: 'string' },
                },
                required: ['answer'],
                additionalProperties: false,
            },
            strict: true,
        });
        expect(countTranslatedTokens(body)).toBeGreaterThan(0);
    });

    test('accepts stop sequences without forwarding them to Responses', () => {
        const body = translateAnthropicToCodex({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            stop_sequences: ['END'],
            messages: [{ role: 'user', content: 'x' }],
        });

        expect('stop' in body).toBe(false);
    });

    test('returns clear validation errors for unsupported request behavior', () => {
        expect(() =>
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                stop_sequences: ['END', 123],
                messages: [{ role: 'user', content: 'x' }],
            }),
        ).toThrow('stop_sequences[1] must be a string.');

        expect(() =>
            translateAnthropicToCodex({
                model: 'gpt-5.4-mini',
                max_tokens: 128,
                output_config: { format: { type: 'json_object', schema: {} } },
                messages: [{ role: 'user', content: 'x' }],
            }),
        ).toThrow('Unsupported output_config.format.type "json_object".');
    });
});

describe('Anthropic response encoding', () => {
    test('maps OpenAI web search calls to Anthropic server tool blocks and usage', async () => {
        const events = await collectAsync(
            processCodexStream(
                mapRawCodexEvents(
                    asyncIterable([
                        { type: 'response.created', response: { id: 'resp_search' } },
                        {
                            type: 'response.output_item.added',
                            output_index: 0,
                            item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress', action: { type: 'search', query: 'latest news' } },
                        },
                        { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' },
                        { type: 'response.web_search_call.completed', output_index: 0, item_id: 'ws_1' },
                        {
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: {
                                type: 'web_search_call',
                                id: 'ws_1',
                                status: 'completed',
                                action: { type: 'search', query: 'claude-code-proxy github', queries: ['claude-code-proxy github'] },
                            },
                        },
                        {
                            type: 'response.output_item.added',
                            output_index: 1,
                            item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
                        },
                        {
                            type: 'response.output_text.delta',
                            output_index: 1,
                            item_id: 'msg_1',
                            content_index: 0,
                            delta: '1. **TechRadar security article** - warns about malware.\n   https://www.techradar.com/pro/security/example',
                        },
                        {
                            type: 'response.output_item.done',
                            output_index: 1,
                            item: {
                                type: 'message',
                                id: 'msg_1',
                                role: 'assistant',
                                status: 'completed',
                                content: [
                                    {
                                        type: 'output_text',
                                        text: '1. **TechRadar security article** - warns about malware.\n   https://www.techradar.com/pro/security/example',
                                        annotations: [],
                                    },
                                ],
                            },
                        },
                        {
                            type: 'response.completed',
                            response: {
                                id: 'resp_search',
                                status: 'completed',
                                output: [],
                                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
                            },
                        },
                    ]),
                ),
                { model: 'gpt-5.4-mini' },
            ),
        );

        const message = collectAnthropicMessage(events);
        expect(message.content).toEqual([
            {
                type: 'server_tool_use',
                id: 'srvtoolu_ws_1',
                name: 'web_search',
                input: { query: 'claude-code-proxy github' },
            },
            {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_ws_1',
                content: [
                    {
                        type: 'web_search_result',
                        title: 'TechRadar security article',
                        url: 'https://www.techradar.com/pro/security/example',
                    },
                ],
            },
            {
                type: 'text',
                text: '1. **TechRadar security article** - warns about malware.\n   https://www.techradar.com/pro/security/example',
            },
        ]);
        expect(message.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    });

    test('encodes internal text events to Anthropic SSE frames', () => {
        const events: InternalAssistantEvent[] = [
            { type: 'message_start', messageId: 'msg_ccx_1', model: 'gpt-5.4-mini', createdAt: 1, initialUsage: { inputTokens: 3 } },
            { type: 'text_start', index: 0 },
            { type: 'text_delta', index: 0, delta: 'Hel' },
            { type: 'text_delta', index: 0, delta: 'lo' },
            { type: 'text_end', index: 0, text: 'Hello' },
            { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 } },
        ];

        const frames = toAnthropicSseFrames(events);
        expect(frames.map((frame) => frame.event)).toEqual([
            'message_start',
            'ping',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop',
        ]);
        expect(encodeAnthropicSse(events)).toContain('event: message_start');
        expect(encodeAnthropicSse(events)).toContain('event: ping');
        expect(encodeAnthropicSse(events)).toContain('"type":"text_delta","text":"Hel"');
    });

    test('encodes internal tool events to Anthropic SSE and non-streaming message JSON', () => {
        const toolId = encodeToolId({ call: 'call_789', item: 'fc_789' });
        const events: InternalAssistantEvent[] = [
            { type: 'message_start', messageId: 'msg_ccx_2', model: 'gpt-5.4-mini', createdAt: 2 },
            { type: 'tool_start', index: 0, id: toolId, name: 'read_file' },
            { type: 'tool_input_delta', index: 0, partialJson: '{"path":' },
            { type: 'tool_input_delta', index: 0, partialJson: '"/tmp/a"}' },
            { type: 'tool_end', index: 0, id: toolId, name: 'read_file', input: { path: '/tmp/a' } },
            { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 5, cacheReadInputTokens: 1 } },
        ];

        const frames = toAnthropicSseFrames(events);
        expect(frames).toContainEqual({
            event: 'content_block_delta',
            data: {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'input_json_delta',
                    partial_json: '{"path":',
                },
            },
        });

        expect(collectAnthropicMessage(events)).toEqual({
            id: 'msg_ccx_2',
            type: 'message',
            role: 'assistant',
            model: 'gpt-5.4-mini',
            content: [{ type: 'tool_use', id: toolId, name: 'read_file', input: { path: '/tmp/a' } }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
                input_tokens: 4,
                output_tokens: 5,
                cache_read_input_tokens: 1,
            },
        });
    });

    test('encodes internal thinking events to Anthropic SSE and non-streaming message JSON', () => {
        const signature = encodeReasoningSignature({
            type: 'reasoning',
            id: 'rs_789',
            summary: [{ type: 'summary_text', text: 'Checked the files.' }],
            encrypted_content: 'encrypted',
        });
        const events: InternalAssistantEvent[] = [
            { type: 'message_start', messageId: 'msg_ccx_3', model: 'gpt-5.4-mini', createdAt: 3 },
            { type: 'thinking_start', index: 0 },
            { type: 'thinking_delta', index: 0, delta: 'Checked ' },
            { type: 'thinking_delta', index: 0, delta: 'the files.' },
            { type: 'thinking_signature_delta', index: 0, signature },
            { type: 'thinking_end', index: 0, thinking: 'Checked the files.', signature },
            { type: 'text_start', index: 1 },
            { type: 'text_delta', index: 1, delta: 'Done.' },
            { type: 'text_end', index: 1, text: 'Done.' },
            { type: 'message_end', stopReason: 'end_turn' },
        ];

        const frames = toAnthropicSseFrames(events);
        expect(frames).toContainEqual({
            event: 'content_block_delta',
            data: {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'thinking_delta',
                    thinking: 'Checked ',
                },
            },
        });
        expect(frames).toContainEqual({
            event: 'content_block_delta',
            data: {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'signature_delta',
                    signature,
                },
            },
        });

        expect(collectAnthropicMessage(events).content).toEqual([
            { type: 'thinking', thinking: 'Checked the files.', signature },
            { type: 'text', text: 'Done.' },
        ]);
    });

    test('redacts reasoning payload fields from debug body traces', () => {
        expect(
            redactBody({
                signature: 'sig',
                thinking: 'chain',
                data: 'opaque',
                encrypted_content: 'encrypted',
                nested: { access_token: 'token', text: 'visible' },
            }),
        ).toEqual({
            signature: '[redacted]',
            thinking: '[redacted]',
            data: '[redacted]',
            encrypted_content: '[redacted]',
            nested: { access_token: '[redacted]', text: 'visible' },
        });
    });
});

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
