import { ProxyValidationError } from '../protocol/errors.ts';
import type { AnthropicWebSearchResult, AnthropicWebSearchToolResultError } from './web-search.ts';

export interface AnthropicMessageRequest {
    model?: string;
    max_tokens?: number;
    messages: AnthropicMessage[];
    system?: AnthropicSystemPrompt;
    tools?: AnthropicTool[];
    stream?: boolean;
    metadata?: Record<string, unknown>;
    temperature?: number;
    stop_sequences?: string[];
    top_p?: number;
    top_k?: number;
    tool_choice?: AnthropicToolChoice;
    thinking?: AnthropicThinkingConfig;
    output_config?: AnthropicOutputConfig;
}

export type AnthropicSystemPrompt = string | AnthropicTextBlock[];

export interface AnthropicMessage {
    role: 'user' | 'assistant' | 'system';
    content: AnthropicMessageContent;
}

export type AnthropicMessageContent = string | AnthropicUserContentBlock[] | AnthropicAssistantContentBlock[] | AnthropicTextBlock[];

export type AnthropicUserContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock;
export type AnthropicAssistantContentBlock =
    | AnthropicTextBlock
    | AnthropicThinkingBlock
    | AnthropicRedactedThinkingBlock
    | AnthropicToolUseBlock
    | AnthropicServerToolUseBlock
    | AnthropicWebSearchToolResultBlock;

export interface AnthropicTextBlock {
    type: 'text';
    text: string;
}

export interface AnthropicImageBlock {
    type: 'image';
    source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

export interface AnthropicToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface AnthropicServerToolUseBlock {
    type: 'server_tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface AnthropicWebSearchToolResultBlock {
    type: 'web_search_tool_result';
    tool_use_id: string;
    content?: AnthropicWebSearchResult[] | AnthropicWebSearchToolResultError;
}

export interface AnthropicThinkingBlock {
    type: 'thinking';
    thinking: string;
    signature: string;
}

export interface AnthropicRedactedThinkingBlock {
    type: 'redacted_thinking';
    data: string;
}

export interface AnthropicToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content?: string | AnthropicToolResultContentBlock[];
    is_error?: boolean;
}

export interface AnthropicToolResultTextBlock {
    type: 'text';
    text: string;
}

export interface AnthropicToolResultImageBlock {
    type: 'image';
    source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

export type AnthropicToolResultContentBlock = AnthropicToolResultTextBlock | AnthropicToolResultImageBlock | (Record<string, unknown> & { type?: unknown });

export type AnthropicTool = AnthropicFunctionTool | AnthropicWebSearchTool;

export interface AnthropicFunctionTool {
    type?: undefined;
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicWebSearchTool {
    type: 'web_search_20250305';
    name: 'web_search';
    max_uses?: number;
    allowed_domains?: string[];
    blocked_domains?: string[];
    user_location?: AnthropicWebSearchUserLocation;
}

export interface AnthropicWebSearchUserLocation {
    type: 'approximate';
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
}

export interface AnthropicToolChoice {
    type: 'auto' | 'any' | 'none' | 'tool';
    name?: string;
    disable_parallel_tool_use?: boolean;
}

export interface AnthropicThinkingConfig {
    type: 'enabled' | 'disabled' | 'adaptive';
    budget_tokens?: number;
}

export interface AnthropicOutputConfig {
    effort?: string;
    format?: AnthropicOutputFormat;
}

export interface AnthropicOutputFormat {
    type: 'json_schema';
    name?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
}

export function isAnthropicWebSearchTool(tool: AnthropicTool): tool is AnthropicWebSearchTool {
    return tool.type === 'web_search_20250305';
}

const UNSUPPORTED_BEHAVIOR_FIELDS = ['container', 'mcp_servers', 'service_tier'] as const;

export interface ParseAnthropicRequestOptions {
    requireMaxTokens?: boolean;
}

export function parseAnthropicRequest(input: unknown, options?: ParseAnthropicRequestOptions): AnthropicMessageRequest {
    const raw = expectRecord(input, 'request body');
    validateUnsupportedRequestFields(raw);
    const requireMaxTokens = options?.requireMaxTokens ?? true;

    const request: AnthropicMessageRequest = {
        messages: parseMessages(raw.messages),
    };

    if (requireMaxTokens || raw.max_tokens !== undefined) {
        request.max_tokens = expectPositiveInteger(raw.max_tokens, 'max_tokens');
    }
    if (raw.model !== undefined) {
        request.model = expectString(raw.model, 'model');
    }
    if (raw.system !== undefined) {
        request.system = parseSystemPrompt(raw.system);
    }
    if (raw.tools !== undefined) {
        request.tools = parseTools(raw.tools);
    }
    if (raw.stream !== undefined) {
        request.stream = expectBoolean(raw.stream, 'stream');
    }
    if (raw.metadata !== undefined) {
        request.metadata = expectRecord(raw.metadata, 'metadata');
    }
    if (raw.temperature !== undefined) {
        request.temperature = expectFiniteNumber(raw.temperature, 'temperature');
    }
    if (raw.stop_sequences !== undefined) {
        request.stop_sequences = parseStringArray(raw.stop_sequences, 'stop_sequences');
    }
    if (raw.top_p !== undefined) {
        request.top_p = expectFiniteNumber(raw.top_p, 'top_p');
        if (request.top_p !== 1) {
            throw new ProxyValidationError('top_p is unsupported in v1 unless it is the default value 1.');
        }
    }
    if (raw.top_k !== undefined) {
        request.top_k = expectFiniteNumber(raw.top_k, 'top_k');
        if (request.top_k !== 0) {
            throw new ProxyValidationError('top_k is unsupported in v1 unless it is the default value 0.');
        }
    }
    if (raw.tool_choice !== undefined) {
        request.tool_choice = parseToolChoice(raw.tool_choice);
    }
    if (raw.thinking !== undefined) {
        request.thinking = parseThinking(raw.thinking);
    }
    if (raw.output_config !== undefined) {
        request.output_config = parseOutputConfig(raw.output_config);
    }

    return request;
}

function validateUnsupportedRequestFields(raw: Record<string, unknown>): void {
    for (const field of UNSUPPORTED_BEHAVIOR_FIELDS) {
        if (raw[field] !== undefined) {
            throw new ProxyValidationError(`${field} is unsupported in v1.`);
        }
    }
}

function parseSystemPrompt(value: unknown): AnthropicSystemPrompt {
    if (typeof value === 'string') {
        return value;
    }

    if (!Array.isArray(value)) {
        throw new ProxyValidationError('system must be a string or an array of text blocks.');
    }

    return value.map((block, index) => {
        const raw = expectRecord(block, `system[${index}]`);
        const type = expectString(raw.type, `system[${index}].type`);
        if (type !== 'text') {
            throw new ProxyValidationError(`Unsupported system block type "${type}" in v1.`);
        }
        return {
            type: 'text',
            text: expectString(raw.text, `system[${index}].text`),
        };
    });
}

function parseMessages(value: unknown): AnthropicMessage[] {
    if (!Array.isArray(value)) {
        throw new ProxyValidationError('messages must be an array.');
    }

    return value.map((message, index) => {
        const raw = expectRecord(message, `messages[${index}]`);
        const role = expectString(raw.role, `messages[${index}].role`);
        if (role !== 'user' && role !== 'assistant' && role !== 'system') {
            throw new ProxyValidationError(`Unsupported message role "${role}".`);
        }

        return {
            role,
            content: parseMessageContent(raw.content, role, index),
        };
    });
}

function parseMessageContent(value: unknown, role: 'user' | 'assistant' | 'system', messageIndex: number): AnthropicMessageContent {
    if (typeof value === 'string') {
        return value;
    }

    if (!Array.isArray(value)) {
        throw new ProxyValidationError(`messages[${messageIndex}].content must be a string or content block array.`);
    }

    if (role === 'system') {
        return value.map((block, blockIndex) => {
            const raw = expectRecord(block, `messages[${messageIndex}].content[${blockIndex}]`);
            const type = expectString(raw.type, `messages[${messageIndex}].content[${blockIndex}].type`);
            if (type !== 'text') {
                throw new ProxyValidationError(`Unsupported system message block type "${type}" in v1.`);
            }
            return {
                type: 'text',
                text: expectString(raw.text, `messages[${messageIndex}].content[${blockIndex}].text`),
            };
        });
    }

    if (role === 'user') {
        return value.map((block, blockIndex) => parseUserContentBlock(block, messageIndex, blockIndex));
    }

    return value.map((block, blockIndex) => parseAssistantContentBlock(block, messageIndex, blockIndex));
}

function parseUserContentBlock(value: unknown, messageIndex: number, blockIndex: number): AnthropicUserContentBlock {
    const raw = expectRecord(value, `messages[${messageIndex}].content[${blockIndex}]`);
    const type = expectString(raw.type, `messages[${messageIndex}].content[${blockIndex}].type`);

    if (type === 'text') {
        return {
            type: 'text',
            text: expectString(raw.text, `messages[${messageIndex}].content[${blockIndex}].text`),
        };
    }

    if (type === 'image') {
        const source = expectRecord(raw.source, `messages[${messageIndex}].content[${blockIndex}].source`);
        const sourceType = expectString(source.type, `messages[${messageIndex}].content[${blockIndex}].source.type`);
        if (sourceType === 'base64') {
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: expectString(source.media_type, `messages[${messageIndex}].content[${blockIndex}].source.media_type`),
                    data: expectString(source.data, `messages[${messageIndex}].content[${blockIndex}].source.data`),
                },
            };
        }
        if (sourceType === 'url') {
            return {
                type: 'image',
                source: {
                    type: 'url',
                    url: expectString(source.url, `messages[${messageIndex}].content[${blockIndex}].source.url`),
                },
            };
        }
        throw new ProxyValidationError(`Unsupported user image source type "${sourceType}" in v1.`);
    }

    if (type === 'tool_result') {
        const block: AnthropicToolResultBlock = {
            type: 'tool_result',
            tool_use_id: expectString(raw.tool_use_id, `messages[${messageIndex}].content[${blockIndex}].tool_use_id`),
        };
        if (raw.content !== undefined) {
            block.content = parseToolResultContent(raw.content, messageIndex, blockIndex);
        }
        if (raw.is_error !== undefined) {
            block.is_error = expectBoolean(raw.is_error, `messages[${messageIndex}].content[${blockIndex}].is_error`);
        }
        return block;
    }

    throw new ProxyValidationError(`Unsupported user content block type "${type}" in v1.`);
}

function parseAssistantContentBlock(value: unknown, messageIndex: number, blockIndex: number): AnthropicAssistantContentBlock {
    const raw = expectRecord(value, `messages[${messageIndex}].content[${blockIndex}]`);
    const type = expectString(raw.type, `messages[${messageIndex}].content[${blockIndex}].type`);

    if (type === 'text') {
        return {
            type: 'text',
            text: expectString(raw.text, `messages[${messageIndex}].content[${blockIndex}].text`),
        };
    }

    if (type === 'tool_use') {
        return {
            type: 'tool_use',
            id: expectString(raw.id, `messages[${messageIndex}].content[${blockIndex}].id`),
            name: expectString(raw.name, `messages[${messageIndex}].content[${blockIndex}].name`),
            input: expectRecord(raw.input, `messages[${messageIndex}].content[${blockIndex}].input`),
        };
    }

    if (type === 'server_tool_use') {
        return {
            type: 'server_tool_use',
            id: expectString(raw.id, `messages[${messageIndex}].content[${blockIndex}].id`),
            name: expectString(raw.name, `messages[${messageIndex}].content[${blockIndex}].name`),
            input: expectRecord(raw.input, `messages[${messageIndex}].content[${blockIndex}].input`),
        };
    }

    if (type === 'web_search_tool_result') {
        const block: AnthropicWebSearchToolResultBlock = {
            type: 'web_search_tool_result',
            tool_use_id: expectString(raw.tool_use_id, `messages[${messageIndex}].content[${blockIndex}].tool_use_id`),
        };
        if (raw.content !== undefined) {
            block.content = parseWebSearchToolResultContent(raw.content, messageIndex, blockIndex);
        }
        return block;
    }

    if (type === 'thinking') {
        return {
            type: 'thinking',
            thinking: expectString(raw.thinking, `messages[${messageIndex}].content[${blockIndex}].thinking`),
            signature: expectString(raw.signature, `messages[${messageIndex}].content[${blockIndex}].signature`),
        };
    }

    if (type === 'redacted_thinking') {
        return {
            type: 'redacted_thinking',
            data: expectString(raw.data, `messages[${messageIndex}].content[${blockIndex}].data`),
        };
    }

    throw new ProxyValidationError(`Unsupported assistant content block type "${type}" in v1.`);
}

function parseToolResultContent(value: unknown, messageIndex: number, blockIndex: number): string | AnthropicToolResultContentBlock[] {
    if (typeof value === 'string') {
        return value;
    }

    if (!Array.isArray(value)) {
        throw new ProxyValidationError(`messages[${messageIndex}].content[${blockIndex}].content must be a string or text block array.`);
    }

    return value.map((item, itemIndex) => expectRecord(item, `messages[${messageIndex}].content[${blockIndex}].content[${itemIndex}]`));
}

function parseWebSearchToolResultContent(
    value: unknown,
    messageIndex: number,
    blockIndex: number,
): AnthropicWebSearchResult[] | AnthropicWebSearchToolResultError {
    if (Array.isArray(value)) {
        return value.map((item, itemIndex) => {
            const raw = expectRecord(item, `messages[${messageIndex}].content[${blockIndex}].content[${itemIndex}]`);
            const type = expectString(raw.type, `messages[${messageIndex}].content[${blockIndex}].content[${itemIndex}].type`);
            if (type !== 'web_search_result') {
                throw new ProxyValidationError(`Unsupported web_search_tool_result content type "${type}".`);
            }
            const parsed: AnthropicWebSearchResult = {
                type,
                title: expectString(raw.title, `messages[${messageIndex}].content[${blockIndex}].content[${itemIndex}].title`),
                url: expectString(raw.url, `messages[${messageIndex}].content[${blockIndex}].content[${itemIndex}].url`),
            };
            if (raw.encrypted_content !== undefined) {
                parsed.encrypted_content = expectString(
                    raw.encrypted_content,
                    `messages[${messageIndex}].content[${blockIndex}].content[${itemIndex}].encrypted_content`,
                );
            }
            if (raw.page_age !== undefined) {
                parsed.page_age =
                    raw.page_age === null
                        ? null
                        : expectString(raw.page_age, `messages[${messageIndex}].content[${blockIndex}].content[${itemIndex}].page_age`);
            }
            return parsed;
        });
    }

    const raw = expectRecord(value, `messages[${messageIndex}].content[${blockIndex}].content`);
    const type = expectString(raw.type, `messages[${messageIndex}].content[${blockIndex}].content.type`);
    if (type !== 'web_search_tool_result_error') {
        throw new ProxyValidationError(`Unsupported web_search_tool_result content type "${type}".`);
    }
    return {
        type,
        error_code: expectString(raw.error_code, `messages[${messageIndex}].content[${blockIndex}].content.error_code`),
    };
}

function parseTools(value: unknown): AnthropicTool[] {
    if (!Array.isArray(value)) {
        throw new ProxyValidationError('tools must be an array.');
    }

    return value.map((tool, index) => {
        const raw = expectRecord(tool, `tools[${index}]`);
        const type = raw.type === undefined ? undefined : expectString(raw.type, `tools[${index}].type`);
        if (type === 'web_search_20250305') {
            return parseWebSearchTool(raw, index);
        }
        if (type?.startsWith('web_search')) {
            throw new ProxyValidationError(`Unsupported hosted web search tool type "${type}". Only web_search_20250305 is supported.`);
        }

        const parsed: AnthropicFunctionTool = {
            name: expectString(raw.name, `tools[${index}].name`),
            input_schema: normalizeToolInputSchema(raw.input_schema),
        };
        if (raw.description !== undefined) {
            parsed.description = expectString(raw.description, `tools[${index}].description`);
        }
        return parsed;
    });
}

function parseWebSearchTool(raw: Record<string, unknown>, index: number): AnthropicWebSearchTool {
    const name = expectString(raw.name, `tools[${index}].name`);
    if (name !== 'web_search') {
        throw new ProxyValidationError('tools[].name must be "web_search" for web_search_20250305.');
    }

    const parsed: AnthropicWebSearchTool = {
        type: 'web_search_20250305',
        name: 'web_search',
    };
    if (raw.max_uses !== undefined) {
        parsed.max_uses = expectPositiveInteger(raw.max_uses, `tools[${index}].max_uses`);
    }
    if (raw.allowed_domains !== undefined) {
        parsed.allowed_domains = parseStringArray(raw.allowed_domains, `tools[${index}].allowed_domains`);
    }
    if (raw.blocked_domains !== undefined) {
        parsed.blocked_domains = parseStringArray(raw.blocked_domains, `tools[${index}].blocked_domains`);
    }
    if (raw.user_location !== undefined) {
        parsed.user_location = parseWebSearchUserLocation(raw.user_location, index);
    }
    return parsed;
}

function parseWebSearchUserLocation(value: unknown, toolIndex: number): AnthropicWebSearchUserLocation {
    const raw = expectRecord(value, `tools[${toolIndex}].user_location`);
    const type = expectString(raw.type, `tools[${toolIndex}].user_location.type`);
    if (type !== 'approximate') {
        throw new ProxyValidationError('tools[].user_location.type must be "approximate".');
    }

    const parsed: AnthropicWebSearchUserLocation = { type };
    if (raw.city !== undefined) {
        parsed.city = expectString(raw.city, `tools[${toolIndex}].user_location.city`);
    }
    if (raw.region !== undefined) {
        parsed.region = expectString(raw.region, `tools[${toolIndex}].user_location.region`);
    }
    if (raw.country !== undefined) {
        parsed.country = expectString(raw.country, `tools[${toolIndex}].user_location.country`);
    }
    if (raw.timezone !== undefined) {
        parsed.timezone = expectString(raw.timezone, `tools[${toolIndex}].user_location.timezone`);
    }
    return parsed;
}

function normalizeToolInputSchema(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return { type: 'object', properties: {} };
}

function parseToolChoice(value: unknown): AnthropicToolChoice {
    const raw = expectRecord(value, 'tool_choice');
    const type = expectString(raw.type, 'tool_choice.type');
    const disableParallelToolUse =
        raw.disable_parallel_tool_use !== undefined ? expectBoolean(raw.disable_parallel_tool_use, 'tool_choice.disable_parallel_tool_use') : undefined;
    if (type === 'auto' || type === 'any' || type === 'none') {
        return { type, disable_parallel_tool_use: disableParallelToolUse };
    }
    if (type === 'tool') {
        return { type, name: expectNonEmptyString(raw.name, 'tool_choice.name'), disable_parallel_tool_use: disableParallelToolUse };
    }
    throw new ProxyValidationError(`Unsupported tool_choice type "${type}".`);
}

function parseThinking(value: unknown): AnthropicThinkingConfig {
    const raw = expectRecord(value, 'thinking');
    const type = expectString(raw.type, 'thinking.type');
    if (type !== 'enabled' && type !== 'disabled' && type !== 'adaptive') {
        throw new ProxyValidationError(`Unsupported thinking.type "${type}".`);
    }

    const parsed: AnthropicThinkingConfig = { type };
    if (raw.budget_tokens !== undefined) {
        parsed.budget_tokens = expectPositiveInteger(raw.budget_tokens, 'thinking.budget_tokens');
    }
    return parsed;
}

function parseOutputConfig(value: unknown): AnthropicOutputConfig {
    const raw = expectRecord(value, 'output_config');
    const parsed: AnthropicOutputConfig = {};
    if (raw.effort !== undefined) {
        parsed.effort = expectString(raw.effort, 'output_config.effort');
    }
    if (raw.format !== undefined) {
        parsed.format = parseOutputFormat(raw.format);
    }
    return parsed;
}

function parseOutputFormat(value: unknown): AnthropicOutputFormat {
    const raw = expectRecord(value, 'output_config.format');
    const type = expectString(raw.type, 'output_config.format.type');
    if (type !== 'json_schema') {
        throw new ProxyValidationError(`Unsupported output_config.format.type "${type}".`);
    }

    const parsed: AnthropicOutputFormat = {
        type,
        schema: expectRecord(raw.schema, 'output_config.format.schema'),
    };
    if (raw.name !== undefined) {
        parsed.name = expectNonEmptyString(raw.name, 'output_config.format.name');
    }
    if (raw.strict !== undefined) {
        parsed.strict = expectBoolean(raw.strict, 'output_config.format.strict');
    }
    return parsed;
}

function parseStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
        throw new ProxyValidationError(`${field} must be an array of strings.`);
    }
    return value.map((item, index) => expectString(item, `${field}[${index}]`));
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ProxyValidationError(`${field} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new ProxyValidationError(`${field} must be a string.`);
    }
    return value;
}

function expectNonEmptyString(value: unknown, field: string): string {
    const parsed = expectString(value, field);
    if (parsed.length === 0) {
        throw new ProxyValidationError(`${field} must not be empty.`);
    }
    return parsed;
}

function expectBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new ProxyValidationError(`${field} must be a boolean.`);
    }
    return value;
}

function expectFiniteNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ProxyValidationError(`${field} must be a finite number.`);
    }
    return value;
}

function expectPositiveInteger(value: unknown, field: string): number {
    const parsed = expectFiniteNumber(value, field);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ProxyValidationError(`${field} must be a positive integer.`);
    }
    return parsed;
}
