import type { AnthropicErrorType } from './errors.ts';
import type { InternalUsage } from './usage.ts';

export type InternalAssistantEvent =
    | InternalMessageStartEvent
    | InternalTextStartEvent
    | InternalTextDeltaEvent
    | InternalTextEndEvent
    | InternalToolStartEvent
    | InternalToolInputDeltaEvent
    | InternalToolEndEvent
    | InternalMessageEndEvent
    | InternalErrorEvent;

export interface InternalMessageStartEvent {
    type: 'message_start';
    messageId: string;
    model: string;
    createdAt: number;
    initialUsage?: InternalUsage;
}

export interface InternalTextStartEvent {
    type: 'text_start';
    index: number;
}

export interface InternalTextDeltaEvent {
    type: 'text_delta';
    index: number;
    delta: string;
}

export interface InternalTextEndEvent {
    type: 'text_end';
    index: number;
    text: string;
}

export interface InternalToolStartEvent {
    type: 'tool_start';
    index: number;
    id: string;
    name: string;
}

export interface InternalToolInputDeltaEvent {
    type: 'tool_input_delta';
    index: number;
    partialJson: string;
}

export interface InternalToolEndEvent {
    type: 'tool_end';
    index: number;
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface InternalMessageEndEvent {
    type: 'message_end';
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
    usage?: InternalUsage;
    upstreamResponseId?: string;
}

export interface InternalErrorEvent {
    type: 'error';
    error: {
        httpStatus: number;
        type: AnthropicErrorType;
        message: string;
    };
}
