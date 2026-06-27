import type { Response, ResponseInput, ResponseOutputItem, ResponseReasoningItem, ResponseStreamEvent } from 'openai/resources/responses/responses.js';
import { extractWebSearchResultsFromText, serverToolUseIdFromCodexWebSearchId } from '../anthropic/web-search.ts';
import { ProxyError } from '../protocol/errors.ts';
import type { InternalAssistantEvent, InternalMessageEndEvent } from '../protocol/events.ts';
import type { InternalUsage } from '../protocol/usage.ts';
import { encodeReasoningSignature } from '../reasoning/signature.ts';
import { createMessageId, shortHash } from '../runtime/id.ts';
import { encodeToolId } from '../tools/tool-id.ts';

export class CodexApiError extends ProxyError {
    readonly code?: string;
    readonly payload?: unknown;

    constructor(message: string, options?: { code?: string; payload?: unknown; httpStatus?: number }) {
        super(message, {
            httpStatus: options?.httpStatus ?? 502,
            errorType: mapCodexErrorType(options?.httpStatus, options?.code, message),
        });
        this.name = 'CodexApiError';
        this.code = options?.code;
        this.payload = options?.payload;
    }
}

export class CodexProtocolError extends ProxyError {
    readonly payload?: unknown;

    constructor(message: string, options?: { payload?: unknown }) {
        super(message, { httpStatus: 502, errorType: 'api_error' });
        this.name = 'CodexProtocolError';
        this.payload = options?.payload;
    }
}

export interface ProcessCodexStreamOptions {
    model: string;
    messageId?: string;
    createdAt?: number;
    onResponseId?: (responseId: string) => void;
    onOutputItemDone?: (item: ResponseOutputItem) => void;
}

interface TextBlockState {
    kind: 'text';
    index: number;
    text: string;
    started: boolean;
    ended: boolean;
    deferred?: boolean;
}

interface ToolBlockState {
    kind: 'tool';
    index: number;
    id: string;
    callId: string;
    itemId: string;
    name: string;
    partialJson: string;
    started: boolean;
    ended: boolean;
}

interface ThinkingBlockState {
    kind: 'thinking';
    index: number;
    itemId: string;
    thinking: string;
    segments: Map<string, string>;
    signature: string;
    item?: ResponseReasoningItem;
    started: boolean;
    ended: boolean;
}

type BlockState = TextBlockState | ThinkingBlockState | ToolBlockState;

interface WebSearchCallState {
    index: number;
    resultIndex: number;
    id: string;
    query: string;
}

type ResponseInputItem = ResponseInput[number];

export async function* mapRawCodexEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
    for await (const event of events) {
        const type = typeof event.type === 'string' ? event.type : undefined;
        if (!type) {
            continue;
        }

        if (type === 'error') {
            const code = typeof event.code === 'string' ? event.code : undefined;
            const message = typeof event.message === 'string' ? event.message : (code ?? 'Unknown Codex error');
            throw new CodexApiError(`Codex error: ${message}`, { code, payload: event });
        }

        if (type === 'response.failed') {
            const response = asRecord(event.response);
            const error = asRecord(response?.error);
            const code = typeof error?.code === 'string' ? error.code : undefined;
            const message = typeof error?.message === 'string' ? error.message : 'Codex response failed';
            throw new CodexApiError(message, { code, payload: event });
        }

        if (type === 'response.done' || type === 'response.incomplete') {
            yield {
                ...event,
                type: 'response.completed',
                response: normalizeResponse(event.response),
            } as ResponseStreamEvent;
            return;
        }

        yield event as unknown as ResponseStreamEvent;

        if (type === 'response.completed') {
            return;
        }
    }
}

export async function* processCodexStream(
    events: AsyncIterable<ResponseStreamEvent>,
    options: ProcessCodexStreamOptions,
): AsyncGenerator<InternalAssistantEvent> {
    let messageStarted = false;
    let nextContentIndex = 0;
    let sawTool = false;
    let webSearchRequests = 0;
    let upstreamResponseId: string | undefined;
    const blocksByOutputIndex = new Map<number, BlockState>();
    const blocksByItemId = new Map<string, BlockState>();
    const webSearchByOutputIndex = new Map<number, WebSearchCallState>();

    const createStart = (): InternalAssistantEvent | undefined => {
        if (messageStarted) {
            return undefined;
        }
        messageStarted = true;
        return {
            type: 'message_start',
            messageId: options.messageId ?? createMessageId(),
            model: options.model,
            createdAt: options.createdAt ?? Date.now(),
        };
    };

    const ensureTextBlock = (outputIndex: number, itemId?: string): TextBlockState => {
        const existing = blocksByOutputIndex.get(outputIndex);
        if (existing?.kind === 'text') {
            return existing;
        }
        const block: TextBlockState = {
            kind: 'text',
            index: nextContentIndex,
            text: '',
            started: false,
            ended: false,
            deferred: webSearchByOutputIndex.size > 0,
        };
        nextContentIndex += 1;
        blocksByOutputIndex.set(outputIndex, block);
        if (itemId) {
            blocksByItemId.set(itemId, block);
        }
        return block;
    };

    const ensureToolBlock = (outputIndex: number, item: { id?: string; call_id: string; name: string; arguments?: string }): ToolBlockState => {
        const existing = blocksByOutputIndex.get(outputIndex);
        if (existing?.kind === 'tool') {
            return existing;
        }
        const itemId = item.id && item.id.length > 0 ? item.id : `fc_${shortHash(item.call_id, 24)}`;
        const block: ToolBlockState = {
            kind: 'tool',
            index: nextContentIndex,
            id: encodeToolId({ call: item.call_id, item: itemId }),
            callId: item.call_id,
            itemId,
            name: item.name,
            partialJson: item.arguments ?? '',
            started: false,
            ended: false,
        };
        nextContentIndex += 1;
        blocksByOutputIndex.set(outputIndex, block);
        blocksByItemId.set(itemId, block);
        sawTool = true;
        return block;
    };

    const ensureThinkingBlock = (outputIndex: number, item: Pick<ResponseReasoningItem, 'id'> & Partial<ResponseReasoningItem>): ThinkingBlockState => {
        const existing = blocksByOutputIndex.get(outputIndex);
        if (existing?.kind === 'thinking') {
            if (item.type === 'reasoning' && Array.isArray(item.summary)) {
                existing.item = item as ResponseReasoningItem;
            }
            return existing;
        }

        const block: ThinkingBlockState = {
            kind: 'thinking',
            index: nextContentIndex,
            itemId: item.id,
            thinking: '',
            segments: new Map(),
            signature: '',
            item: item.type === 'reasoning' && Array.isArray(item.summary) ? (item as ResponseReasoningItem) : undefined,
            started: false,
            ended: false,
        };
        nextContentIndex += 1;
        blocksByOutputIndex.set(outputIndex, block);
        blocksByItemId.set(item.id, block);
        return block;
    };

    const startBlockEvents = function* (block: BlockState): Generator<InternalAssistantEvent> {
        const start = createStart();
        if (start) {
            yield start;
        }

        if (block.started) {
            return;
        }
        block.started = true;

        if (block.kind === 'text') {
            if (block.deferred) {
                block.started = true;
                return;
            }
            yield {
                type: 'text_start',
                index: block.index,
            };
            return;
        }

        if (block.kind === 'thinking') {
            yield {
                type: 'thinking_start',
                index: block.index,
            };
            return;
        }

        yield {
            type: 'tool_start',
            index: block.index,
            id: block.id,
            name: block.name,
        };
    };

    for await (const event of events) {
        if (event.type === 'response.created') {
            upstreamResponseId = event.response.id;
            options.onResponseId?.(upstreamResponseId);
            const start = createStart();
            if (start) {
                yield start;
            }
            continue;
        }

        if (event.type === 'response.output_item.added') {
            const item = event.item;
            if (item.type === 'message') {
                const block = ensureTextBlock(event.output_index, item.id);
                for (const startEvent of startBlockEvents(block)) {
                    yield startEvent;
                }
            } else if (item.type === 'reasoning') {
                const block = ensureThinkingBlock(event.output_index, item);
                for (const startEvent of startBlockEvents(block)) {
                    yield startEvent;
                }
            } else if (item.type === 'function_call') {
                const block = ensureToolBlock(event.output_index, item);
                for (const startEvent of startBlockEvents(block)) {
                    yield startEvent;
                }
                if (block.partialJson.length > 0) {
                    yield {
                        type: 'tool_input_delta',
                        index: block.index,
                        partialJson: block.partialJson,
                    };
                }
            } else if (item.type === 'web_search_call') {
                webSearchByOutputIndex.set(event.output_index, {
                    index: nextContentIndex,
                    resultIndex: nextContentIndex + 1,
                    id: serverToolUseIdFromCodexWebSearchId(item.id),
                    query: '',
                });
                nextContentIndex += 2;
            }
            continue;
        }

        if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
            const segmentKey = getReasoningSegmentKey(event);
            const block = ensureThinkingBlock(event.output_index, {
                id: event.item_id,
                type: 'reasoning',
                summary: [],
            });
            for (const startEvent of startBlockEvents(block)) {
                yield startEvent;
            }
            block.segments.set(segmentKey, `${block.segments.get(segmentKey) ?? ''}${event.delta}`);
            block.thinking += event.delta;
            yield {
                type: 'thinking_delta',
                index: block.index,
                delta: event.delta,
            };
            continue;
        }

        if (event.type === 'response.reasoning_summary_text.done' || event.type === 'response.reasoning_text.done') {
            const segmentKey = getReasoningSegmentKey(event);
            const block = ensureThinkingBlock(event.output_index, {
                id: event.item_id,
                type: 'reasoning',
                summary: [],
            });
            for (const startEvent of startBlockEvents(block)) {
                yield startEvent;
            }
            const previousSegment = block.segments.get(segmentKey) ?? '';
            const delta = missingSuffix(previousSegment, event.text);
            if (delta.length > 0) {
                yield {
                    type: 'thinking_delta',
                    index: block.index,
                    delta,
                };
            }
            block.segments.set(segmentKey, event.text);
            block.thinking = mergeReasoningSegments(block.segments);
            continue;
        }

        if (event.type === 'response.output_text.delta') {
            const block = ensureTextBlock(event.output_index, event.item_id);
            for (const startEvent of startBlockEvents(block)) {
                yield startEvent;
            }
            block.text += event.delta;
            if (block.deferred) {
                continue;
            }
            yield {
                type: 'text_delta',
                index: block.index,
                delta: event.delta,
            };
            continue;
        }

        if (event.type === 'response.refusal.delta') {
            const block = ensureTextBlock(event.output_index, event.item_id);
            for (const startEvent of startBlockEvents(block)) {
                yield startEvent;
            }
            block.text += event.delta;
            if (block.deferred) {
                continue;
            }
            yield {
                type: 'text_delta',
                index: block.index,
                delta: event.delta,
            };
            continue;
        }

        if (event.type === 'response.function_call_arguments.delta') {
            const block = getToolBlock(blocksByItemId, blocksByOutputIndex, event.item_id, event.output_index);
            if (!block) {
                continue;
            }
            for (const startEvent of startBlockEvents(block)) {
                yield startEvent;
            }
            block.partialJson += event.delta;
            yield {
                type: 'tool_input_delta',
                index: block.index,
                partialJson: event.delta,
            };
            continue;
        }

        if (event.type === 'response.function_call_arguments.done') {
            const block = getToolBlock(blocksByItemId, blocksByOutputIndex, event.item_id, event.output_index);
            if (!block) {
                continue;
            }
            for (const startEvent of startBlockEvents(block)) {
                yield startEvent;
            }
            if (event.arguments.startsWith(block.partialJson)) {
                const delta = event.arguments.slice(block.partialJson.length);
                if (delta.length > 0) {
                    yield {
                        type: 'tool_input_delta',
                        index: block.index,
                        partialJson: delta,
                    };
                }
            }
            block.partialJson = event.arguments;
            continue;
        }

        if (event.type === 'response.output_item.done') {
            options.onOutputItemDone?.(event.item);
            if (event.item.type === 'message') {
                const block = ensureTextBlock(event.output_index, event.item.id);
                for (const startEvent of startBlockEvents(block)) {
                    yield startEvent;
                }
                block.text = event.item.content.map((part) => (part.type === 'output_text' ? part.text : part.refusal)).join('');
                if (block.deferred) {
                    continue;
                }
                if (!block.ended) {
                    block.ended = true;
                    yield {
                        type: 'text_end',
                        index: block.index,
                        text: block.text,
                    };
                }
            } else if (event.item.type === 'web_search_call') {
                const search = webSearchByOutputIndex.get(event.output_index);
                if (search) {
                    search.query = webSearchQuery(event.item);
                    webSearchRequests += 1;
                }
            } else if (event.item.type === 'reasoning') {
                const block = ensureThinkingBlock(event.output_index, event.item);
                for (const startEvent of startBlockEvents(block)) {
                    yield startEvent;
                }
                const thinking = extractReasoningText(event.item, block.thinking);
                const delta = missingSuffix(block.thinking, thinking);
                if (delta.length > 0) {
                    block.thinking += delta;
                    yield {
                        type: 'thinking_delta',
                        index: block.index,
                        delta,
                    };
                } else {
                    block.thinking = thinking;
                }
                block.item = event.item;
                block.signature = encodeReasoningSignature(event.item);
                if (!block.ended) {
                    block.ended = true;
                    yield {
                        type: 'thinking_signature_delta',
                        index: block.index,
                        signature: block.signature,
                    };
                    yield {
                        type: 'thinking_end',
                        index: block.index,
                        thinking: block.thinking,
                        signature: block.signature,
                    };
                }
            } else if (event.item.type === 'function_call') {
                const block = ensureToolBlock(event.output_index, event.item);
                for (const startEvent of startBlockEvents(block)) {
                    yield startEvent;
                }
                block.partialJson = event.item.arguments || block.partialJson || '{}';
                if (!block.ended) {
                    block.ended = true;
                    yield {
                        type: 'tool_end',
                        index: block.index,
                        id: block.id,
                        name: block.name,
                        input: parseToolInput(block.partialJson),
                    };
                }
            }
            continue;
        }

        if (event.type === 'response.failed') {
            throw new CodexApiError(event.response.error?.message ?? 'Codex response failed', {
                code: event.response.error?.code ?? undefined,
                payload: event,
            });
        }

        if (event.type === 'response.completed') {
            const response = event.response;
            upstreamResponseId = response.id;
            options.onResponseId?.(response.id);
            const start = createStart();
            if (start) {
                yield start;
            }
            if (webSearchByOutputIndex.size > 0) {
                const text = [...blocksByOutputIndex.values()]
                    .filter((block): block is TextBlockState => block.kind === 'text')
                    .map((block) => block.text)
                    .join('\n');
                const results = extractWebSearchResultsFromText(text);
                for (const search of webSearchByOutputIndex.values()) {
                    yield {
                        type: 'server_tool_use',
                        index: search.index,
                        id: search.id,
                        name: 'web_search',
                        input: { query: search.query },
                    };
                    yield {
                        type: 'web_search_tool_result',
                        index: search.resultIndex,
                        toolUseId: search.id,
                        content: results,
                    };
                }
                for (const block of deferredTextBlocks(blocksByOutputIndex)) {
                    yield {
                        type: 'text_start',
                        index: block.index,
                    };
                    if (block.text.length > 0) {
                        yield {
                            type: 'text_delta',
                            index: block.index,
                            delta: block.text,
                        };
                    }
                    block.ended = true;
                    yield {
                        type: 'text_end',
                        index: block.index,
                        text: block.text,
                    };
                }
            }
            for (const closeEvent of closeOpenBlocks(blocksByOutputIndex)) {
                yield closeEvent;
            }
            if (response.status === 'failed' || response.status === 'cancelled') {
                throw new CodexApiError(response.error?.message ?? `Codex response ${response.status}`, {
                    code: response.error?.code ?? response.status,
                    payload: response,
                });
            }
            yield {
                type: 'message_end',
                stopReason: mapStopReason(response, sawTool),
                usage: mapUsage(response, webSearchRequests),
                upstreamResponseId,
            } satisfies InternalMessageEndEvent;
            return;
        }

        if (event.type === 'error') {
            throw new CodexApiError(event.message || 'Codex stream error', {
                code: event.code ?? undefined,
                payload: event,
            });
        }
    }
}

export function createReplayInputItemFromResponseOutputItem(item: ResponseOutputItem): ResponseInputItem | undefined {
    if (item.type === 'message') {
        return {
            type: 'message',
            role: 'assistant',
            id: item.id,
            status: 'completed',
            content: [
                {
                    type: 'output_text',
                    text: item.content.map((part) => (part.type === 'output_text' ? part.text : part.refusal)).join(''),
                    annotations: [],
                },
            ],
        };
    }

    if (item.type === 'function_call') {
        return {
            type: 'function_call',
            id: item.id,
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments || '{}',
        };
    }

    if (item.type === 'reasoning') {
        return item;
    }

    return undefined;
}

function getToolBlock(
    byItemId: Map<string, BlockState>,
    byOutputIndex: Map<number, BlockState>,
    itemId: string,
    outputIndex: number,
): ToolBlockState | undefined {
    const byItem = byItemId.get(itemId);
    if (byItem?.kind === 'tool') {
        return byItem;
    }
    const byOutput = byOutputIndex.get(outputIndex);
    return byOutput?.kind === 'tool' ? byOutput : undefined;
}

function deferredTextBlocks(blocks: Map<number, BlockState>): TextBlockState[] {
    return [...blocks.values()]
        .filter((block): block is TextBlockState => block.kind === 'text' && block.deferred === true)
        .sort((left, right) => left.index - right.index);
}

function* closeOpenBlocks(blocks: Map<number, BlockState>): Generator<InternalAssistantEvent> {
    for (const block of blocks.values()) {
        if (!block.started || block.ended) {
            continue;
        }
        block.ended = true;
        if (block.kind === 'text') {
            yield {
                type: 'text_end',
                index: block.index,
                text: block.text,
            };
        } else if (block.kind === 'thinking') {
            const item = block.item ?? createSyntheticReasoningItem(block);
            block.signature = encodeReasoningSignature(item);
            yield {
                type: 'thinking_signature_delta',
                index: block.index,
                signature: block.signature,
            };
            yield {
                type: 'thinking_end',
                index: block.index,
                thinking: block.thinking,
                signature: block.signature,
            };
        } else {
            yield {
                type: 'tool_end',
                index: block.index,
                id: block.id,
                name: block.name,
                input: parseToolInput(block.partialJson || '{}'),
            };
        }
    }
}

function webSearchQuery(item: unknown): string {
    const action = asRecord(asRecord(item)?.action);
    const queries = action?.queries;
    if (Array.isArray(queries)) {
        const first = queries.find((query) => typeof query === 'string');
        if (typeof first === 'string') {
            return first;
        }
    }
    const query = action?.query;
    return typeof query === 'string' ? query : '';
}

function parseToolInput(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value || '{}');
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Fall through to protocol error below.
    }
    throw new CodexProtocolError('Codex emitted malformed function-call JSON arguments.', { payload: value });
}

function extractReasoningText(item: ResponseReasoningItem, fallback: string): string {
    const summaryText = item.summary.map((part) => part.text).join('');
    if (summaryText.length > 0) {
        return summaryText;
    }

    const contentText = item.content?.map((part) => part.text).join('') ?? '';
    if (contentText.length > 0) {
        return contentText;
    }

    return fallback;
}

function missingSuffix(current: string, finalText: string): string {
    if (finalText.length === 0 || current === finalText) {
        return '';
    }
    if (finalText.startsWith(current)) {
        return finalText.slice(current.length);
    }
    return current.length === 0 ? finalText : '';
}

function getReasoningSegmentKey(
    event:
        | { type: 'response.reasoning_summary_text.delta' | 'response.reasoning_summary_text.done'; summary_index: number }
        | { type: 'response.reasoning_text.delta' | 'response.reasoning_text.done'; content_index: number },
): string {
    if ('summary_index' in event) {
        return `summary:${event.summary_index}`;
    }
    return `content:${event.content_index}`;
}

function mergeReasoningSegments(segments: Map<string, string>): string {
    return [...segments.entries()]
        .sort(([left], [right]) => compareSegmentKeys(left, right))
        .map(([, text]) => text)
        .join('');
}

function compareSegmentKeys(left: string, right: string): number {
    const [leftKind, leftIndex = '0'] = left.split(':', 2);
    const [rightKind, rightIndex = '0'] = right.split(':', 2);
    if (leftKind !== rightKind) {
        return leftKind === 'summary' ? -1 : 1;
    }
    return Number(leftIndex) - Number(rightIndex);
}

function createSyntheticReasoningItem(block: ThinkingBlockState): ResponseReasoningItem {
    return {
        id: block.itemId,
        type: 'reasoning',
        summary: block.thinking.length > 0 ? [{ type: 'summary_text', text: block.thinking }] : [],
        status: 'completed',
    };
}

function mapUsage(response: Response, webSearchRequests = 0): InternalUsage | undefined {
    if (!response.usage) {
        return webSearchRequests > 0 ? { webSearchRequests } : undefined;
    }
    const inputTokens = response.usage.input_tokens;
    const cachedTokens = Math.max(0, response.usage.input_tokens_details?.cached_tokens ?? 0);
    return {
        inputTokens: Math.max(0, inputTokens - cachedTokens),
        outputTokens: response.usage.output_tokens,
        cacheReadInputTokens: cachedTokens,
        webSearchRequests,
    };
}

function mapStopReason(response: Response, sawTool: boolean): InternalMessageEndEvent['stopReason'] {
    if (sawTool) {
        return 'tool_use';
    }
    if (response.status === 'incomplete') {
        return 'max_tokens';
    }
    return 'end_turn';
}

function normalizeResponse(value: unknown): unknown {
    const response = asRecord(value);
    if (!response) {
        return value;
    }
    const status = typeof response.status === 'string' ? response.status : undefined;
    return {
        ...response,
        status,
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function mapCodexErrorType(status: number | undefined, code: string | undefined, message: string) {
    if (status === 401) {
        return 'authentication_error';
    }
    if (status === 403) {
        return 'permission_error';
    }
    if (status === 413) {
        return 'request_too_large';
    }
    if (status === 429 || /usage_limit|rate_limit|quota|billing|usage/i.test(code ?? message)) {
        return 'rate_limit_error';
    }
    if (status === 503 || status === 529 || /overloaded|unavailable/i.test(message)) {
        return 'overloaded_error';
    }
    if (/context|maximum context|too many tokens/i.test(message)) {
        return 'invalid_request_error';
    }
    return 'api_error';
}
