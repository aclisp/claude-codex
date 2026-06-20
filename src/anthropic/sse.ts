import { ProxyError, toAnthropicErrorBody } from '../protocol/errors.ts';
import type { InternalAssistantEvent } from '../protocol/events.ts';
import { toAnthropicUsage } from '../protocol/usage.ts';

export interface AnthropicSseFrame {
    event: string;
    data: unknown;
}

export function toAnthropicSseFrames(events: Iterable<InternalAssistantEvent>): AnthropicSseFrame[] {
    const frames: AnthropicSseFrame[] = [];

    for (const event of events) {
        if (event.type === 'message_start') {
            frames.push({
                event: 'message_start',
                data: {
                    type: 'message_start',
                    message: {
                        id: event.messageId,
                        type: 'message',
                        role: 'assistant',
                        model: event.model,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: toAnthropicUsage(event.initialUsage),
                    },
                },
            });
        } else if (event.type === 'text_start') {
            frames.push({
                event: 'content_block_start',
                data: {
                    type: 'content_block_start',
                    index: event.index,
                    content_block: {
                        type: 'text',
                        text: '',
                    },
                },
            });
        } else if (event.type === 'thinking_start') {
            frames.push({
                event: 'content_block_start',
                data: {
                    type: 'content_block_start',
                    index: event.index,
                    content_block: {
                        type: 'thinking',
                        thinking: '',
                    },
                },
            });
        } else if (event.type === 'thinking_delta') {
            frames.push({
                event: 'content_block_delta',
                data: {
                    type: 'content_block_delta',
                    index: event.index,
                    delta: {
                        type: 'thinking_delta',
                        thinking: event.delta,
                    },
                },
            });
        } else if (event.type === 'thinking_signature_delta') {
            frames.push({
                event: 'content_block_delta',
                data: {
                    type: 'content_block_delta',
                    index: event.index,
                    delta: {
                        type: 'signature_delta',
                        signature: event.signature,
                    },
                },
            });
        } else if (event.type === 'thinking_end') {
            frames.push({
                event: 'content_block_stop',
                data: {
                    type: 'content_block_stop',
                    index: event.index,
                },
            });
        } else if (event.type === 'text_delta') {
            frames.push({
                event: 'content_block_delta',
                data: {
                    type: 'content_block_delta',
                    index: event.index,
                    delta: {
                        type: 'text_delta',
                        text: event.delta,
                    },
                },
            });
        } else if (event.type === 'text_end') {
            frames.push({
                event: 'content_block_stop',
                data: {
                    type: 'content_block_stop',
                    index: event.index,
                },
            });
        } else if (event.type === 'tool_start') {
            frames.push({
                event: 'content_block_start',
                data: {
                    type: 'content_block_start',
                    index: event.index,
                    content_block: {
                        type: 'tool_use',
                        id: event.id,
                        name: event.name,
                        input: {},
                    },
                },
            });
        } else if (event.type === 'tool_input_delta') {
            frames.push({
                event: 'content_block_delta',
                data: {
                    type: 'content_block_delta',
                    index: event.index,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: event.partialJson,
                    },
                },
            });
        } else if (event.type === 'tool_end') {
            frames.push({
                event: 'content_block_stop',
                data: {
                    type: 'content_block_stop',
                    index: event.index,
                },
            });
        } else if (event.type === 'message_end') {
            frames.push(
                {
                    event: 'message_delta',
                    data: {
                        type: 'message_delta',
                        delta: {
                            stop_reason: event.stopReason,
                            stop_sequence: null,
                        },
                        usage: toAnthropicUsage(event.usage),
                    },
                },
                {
                    event: 'message_stop',
                    data: {
                        type: 'message_stop',
                    },
                },
            );
        } else if (event.type === 'error') {
            frames.push({
                event: 'error',
                data: toAnthropicErrorBody(new ProxyError(event.error.message, { httpStatus: event.error.httpStatus, errorType: event.error.type })),
            });
        }
    }

    return frames;
}

export function encodeAnthropicSse(events: Iterable<InternalAssistantEvent>): string {
    return toAnthropicSseFrames(events).map(encodeSseFrame).join('');
}

export function encodeSseFrame(frame: AnthropicSseFrame): string {
    return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
