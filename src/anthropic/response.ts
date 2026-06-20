import { ProxyError, ProxyValidationError } from '../protocol/errors.ts';
import type { InternalAssistantEvent, InternalMessageEndEvent, InternalMessageStartEvent } from '../protocol/events.ts';
import { type AnthropicUsage, toAnthropicUsage } from '../protocol/usage.ts';

export interface AnthropicMessageResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: AnthropicResponseContentBlock[];
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
    stop_sequence: null;
    usage: AnthropicUsage;
}

export type AnthropicResponseContentBlock = AnthropicTextResponseBlock | AnthropicThinkingResponseBlock | AnthropicToolUseResponseBlock;

export interface AnthropicTextResponseBlock {
    type: 'text';
    text: string;
}

export interface AnthropicToolUseResponseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface AnthropicThinkingResponseBlock {
    type: 'thinking';
    thinking: string;
    signature: string;
}

export function collectAnthropicMessage(events: Iterable<InternalAssistantEvent>): AnthropicMessageResponse {
    let start: InternalMessageStartEvent | undefined;
    let end: InternalMessageEndEvent | undefined;
    const content: AnthropicResponseContentBlock[] = [];

    for (const event of events) {
        if (event.type === 'message_start') {
            if (start !== undefined) {
                throw new ProxyValidationError('Internal event stream emitted multiple message_start events.');
            }
            start = event;
            continue;
        }

        if (event.type === 'error') {
            throw new ProxyError(event.error.message, { httpStatus: event.error.httpStatus, errorType: event.error.type });
        }

        if (start === undefined) {
            throw new ProxyValidationError(`Internal event "${event.type}" arrived before message_start.`);
        }

        if (event.type === 'text_start') {
            setContentBlock(content, event.index, {
                type: 'text',
                text: '',
            });
        } else if (event.type === 'thinking_start') {
            setContentBlock(content, event.index, {
                type: 'thinking',
                thinking: '',
                signature: '',
            });
        } else if (event.type === 'thinking_delta') {
            const block = expectThinkingBlock(content, event.index);
            block.thinking += event.delta;
        } else if (event.type === 'thinking_signature_delta') {
            const block = expectThinkingBlock(content, event.index);
            block.signature += event.signature;
        } else if (event.type === 'thinking_end') {
            const block = expectThinkingBlock(content, event.index);
            block.thinking = event.thinking;
            block.signature = event.signature;
        } else if (event.type === 'text_delta') {
            const block = expectTextBlock(content, event.index);
            block.text += event.delta;
        } else if (event.type === 'text_end') {
            const block = expectTextBlock(content, event.index);
            block.text = event.text;
        } else if (event.type === 'tool_start') {
            setContentBlock(content, event.index, {
                type: 'tool_use',
                id: event.id,
                name: event.name,
                input: {},
            });
        } else if (event.type === 'tool_end') {
            const block = expectToolBlock(content, event.index);
            block.id = event.id;
            block.name = event.name;
            block.input = event.input;
        } else if (event.type === 'message_end') {
            end = event;
        }
    }

    if (start === undefined) {
        throw new ProxyValidationError('Internal event stream did not emit message_start.');
    }
    if (end === undefined) {
        throw new ProxyValidationError('Internal event stream did not emit message_end.');
    }

    return {
        id: start.messageId,
        type: 'message',
        role: 'assistant',
        model: start.model,
        content,
        stop_reason: end.stopReason,
        stop_sequence: null,
        usage: toAnthropicUsage(end.usage ?? start.initialUsage),
    };
}

function setContentBlock(content: AnthropicResponseContentBlock[], index: number, block: AnthropicResponseContentBlock): void {
    if (!Number.isInteger(index) || index < 0) {
        throw new ProxyValidationError(`Invalid content block index ${index}.`);
    }
    content[index] = block;
}

function expectTextBlock(content: AnthropicResponseContentBlock[], index: number): AnthropicTextResponseBlock {
    const block = content[index];
    if (block?.type !== 'text') {
        throw new ProxyValidationError(`Expected text content block at index ${index}.`);
    }
    return block;
}

function expectThinkingBlock(content: AnthropicResponseContentBlock[], index: number): AnthropicThinkingResponseBlock {
    const block = content[index];
    if (block?.type !== 'thinking') {
        throw new ProxyValidationError(`Expected thinking content block at index ${index}.`);
    }
    return block;
}

function expectToolBlock(content: AnthropicResponseContentBlock[], index: number): AnthropicToolUseResponseBlock {
    const block = content[index];
    if (block?.type !== 'tool_use') {
        throw new ProxyValidationError(`Expected tool_use content block at index ${index}.`);
    }
    return block;
}
