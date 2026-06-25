import { encode } from 'gpt-tokenizer/model/gpt-5';
import type { CodexResponsesRequest } from './request.ts';

const IMAGE_TOKEN_ESTIMATE = 2000;
const ITEM_OVERHEAD_ESTIMATE = 4;

export function countTranslatedTokens(request: Pick<CodexResponsesRequest, 'instructions' | 'input' | 'tools' | 'text' | 'tool_choice'>): number {
    let total = 0;

    if (request.instructions.length > 0) {
        total += tokenCount(request.instructions);
    }

    for (const item of request.input) {
        total += countInputItem(item);
    }

    total += countTools(request.tools);
    total += countTextConfig(request.text);
    total += countToolChoice(request.tool_choice);
    total += request.input.length * ITEM_OVERHEAD_ESTIMATE;

    return total;
}

function countInputItem(item: unknown): number {
    if (!isRecord(item)) {
        return 0;
    }

    if (item.type === 'message' || item.role === 'user') {
        return countMessageContent(item.content);
    }
    if (item.type === 'function_call') {
        return tokenCount(asString(item.call_id)) + tokenCount(asString(item.name)) + tokenCount(asString(item.arguments));
    }
    if (item.type === 'function_call_output') {
        return tokenCount(asString(item.call_id)) + tokenCount(asString(item.output));
    }
    if (item.type === 'reasoning') {
        return tokenCount(JSON.stringify(item));
    }

    return tokenCount(JSON.stringify(item));
}

function countMessageContent(content: unknown): number {
    if (typeof content === 'string') {
        return tokenCount(content);
    }
    if (!Array.isArray(content)) {
        return 0;
    }

    return content.reduce((total, part) => total + countContentPart(part), 0);
}

function countContentPart(part: unknown): number {
    if (!isRecord(part)) {
        return 0;
    }
    if (part.type === 'input_text' || part.type === 'output_text') {
        return tokenCount(asString(part.text));
    }
    if (part.type === 'input_image') {
        return IMAGE_TOKEN_ESTIMATE;
    }
    return tokenCount(JSON.stringify(part));
}

function countTools(tools: CodexResponsesRequest['tools']): number {
    if (!tools) {
        return 0;
    }

    return tools.reduce((total, tool) => {
        if (!isRecord(tool)) {
            return total;
        }
        if (asString(tool.type) !== 'function') {
            return total + tokenCount(JSON.stringify(tool));
        }
        const nameOrType = 'name' in tool ? asString(tool.name) : asString(tool.type);
        const description = 'description' in tool ? asString(tool.description) : '';
        const parameters = 'parameters' in tool && tool.parameters !== undefined ? JSON.stringify(tool.parameters) : '';
        return total + tokenCount(nameOrType) + tokenCount(description) + tokenCount(parameters);
    }, 0);
}

function countTextConfig(text: CodexResponsesRequest['text']): number {
    const format = text.format;
    if (!isRecord(format) || format.type !== 'json_schema') {
        return 0;
    }

    return tokenCount(asString(format.name)) + tokenCount(JSON.stringify(format.schema));
}

function countToolChoice(toolChoice: CodexResponsesRequest['tool_choice']): number {
    if (typeof toolChoice === 'string') {
        return tokenCount(toolChoice);
    }
    if (!isRecord(toolChoice)) {
        return 0;
    }

    return tokenCount(asString(toolChoice.type)) + ('name' in toolChoice ? tokenCount(asString(toolChoice.name)) : 0);
}

function tokenCount(value: string): number {
    return value.length === 0 ? 0 : encode(value).length;
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
