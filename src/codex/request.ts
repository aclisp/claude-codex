import type {
    Tool as OpenAIResponseTool,
    ResponseCreateParamsStreaming,
    ResponseInput,
    ResponseReasoningItem,
    ResponseTextConfig,
} from 'openai/resources/responses/responses.js';
import type {
    AnthropicAssistantContentBlock,
    AnthropicFunctionTool,
    AnthropicMessageRequest,
    AnthropicSystemPrompt,
    AnthropicTool,
    AnthropicToolResultBlock,
    AnthropicToolResultContentBlock,
    AnthropicUserContentBlock,
    AnthropicWebSearchTool,
} from '../anthropic/request.ts';
import { isAnthropicWebSearchTool, parseAnthropicRequest } from '../anthropic/request.ts';
import { ProxyValidationError } from '../protocol/errors.ts';
import { decodeReasoningSignature } from '../reasoning/signature.ts';
import { decodeToolId } from '../tools/tool-id.ts';
import { type CodexModelId, DEFAULT_CODEX_MODEL_ID, validateCodexModelId } from './models.ts';

export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexTextVerbosity = 'low' | 'medium' | 'high';
type CodexToolChoice = NonNullable<ResponseCreateParamsStreaming['tool_choice']> | { type: 'web_search' };

export interface BuildCodexRequestOptions {
    defaultModel?: CodexModelId;
    defaultEffort?: CodexReasoningEffort;
    promptCacheKey?: string;
    textVerbosity?: CodexTextVerbosity;
}

export interface CodexResponsesRequest {
    model: CodexModelId;
    store: false;
    stream: true;
    instructions: string;
    input: ResponseInput;
    include: ResponseCreateParamsStreaming['include'];
    text: ResponseTextConfig;
    tool_choice: CodexToolChoice;
    parallel_tool_calls: boolean;
    tools?: OpenAIResponseTool[];
    temperature?: number;
    reasoning?: {
        effort: CodexReasoningEffort;
        summary: 'auto';
    };
    prompt_cache_key?: string;
    previous_response_id?: string;
}

interface CodexInputMessage {
    role: 'user' | 'developer';
    content: CodexInputContent[];
}

type CodexInputContent = CodexInputText | CodexInputImage;

interface CodexInputText {
    type: 'input_text';
    text: string;
}

interface CodexInputImage {
    type: 'input_image';
    detail: 'auto';
    image_url: string;
}

interface CodexAssistantMessageItem {
    type: 'message';
    role: 'assistant';
    id: string;
    status: 'completed';
    content: Array<{
        type: 'output_text';
        text: string;
        annotations: [];
    }>;
}

interface CodexFunctionCallItem {
    type: 'function_call';
    id: string;
    call_id: string;
    name: string;
    arguments: string;
}

interface CodexFunctionCallOutputItem {
    type: 'function_call_output';
    call_id: string;
    output: string;
}

type CodexInputItem = CodexInputMessage | CodexAssistantMessageItem | CodexFunctionCallItem | CodexFunctionCallOutputItem | ResponseReasoningItem;

export function translateAnthropicToCodex(input: unknown, options?: BuildCodexRequestOptions): CodexResponsesRequest {
    return buildCodexRequest(parseAnthropicRequest(input), options);
}

export function buildCodexRequest(request: AnthropicMessageRequest, options?: BuildCodexRequestOptions): CodexResponsesRequest {
    const model = validateCodexModelId(request.model ?? options?.defaultModel ?? DEFAULT_CODEX_MODEL_ID);
    const toolChoice = mapToolChoice(request.tool_choice, request.tools);
    const translatedInput = translateMessages(request);
    const effort = resolveReasoningEffort(request, options?.defaultEffort ?? 'medium');

    const body: CodexResponsesRequest = {
        model,
        store: false,
        stream: true,
        instructions: buildInstructions(request),
        input: translatedInput as ResponseInput,
        include: ['reasoning.encrypted_content'],
        text: buildTextConfig(request, options?.textVerbosity ?? 'low'),
        tool_choice: toolChoice,
        parallel_tool_calls: request.tool_choice?.disable_parallel_tool_use !== true,
        reasoning: {
            effort,
            summary: 'auto',
        },
    };

    if (request.temperature !== undefined) {
        body.temperature = request.temperature;
    }
    if (options?.promptCacheKey !== undefined) {
        body.prompt_cache_key = options.promptCacheKey;
    }
    if (request.tools !== undefined && request.tools.length > 0 && toolChoice !== 'none') {
        body.tools = translateTools(request.tools);
    }

    return body;
}

export function mapToolChoice(choice: AnthropicMessageRequest['tool_choice'], tools?: AnthropicTool[]): CodexToolChoice {
    if (choice === undefined || choice.type === 'auto') {
        return 'auto';
    }
    if (choice.type === 'none') {
        return 'none';
    }
    if (choice.type === 'any') {
        return 'required';
    }
    if (!choice.name) {
        throw new ProxyValidationError('tool_choice.name is required when tool_choice.type is "tool".');
    }
    if (tools?.some((tool) => isAnthropicWebSearchTool(tool) && tool.name === choice.name)) {
        return { type: 'web_search' };
    }
    return { type: 'function', name: choice.name };
}

function buildTextConfig(request: AnthropicMessageRequest, verbosity: CodexTextVerbosity): ResponseTextConfig {
    const text: ResponseTextConfig = { verbosity };
    const format = request.output_config?.format;
    if (format?.type === 'json_schema') {
        text.format = {
            type: 'json_schema',
            name: format.name ?? 'response',
            schema: normalizeStrictJsonSchema(format.schema),
            strict: true,
        };
    }
    return text;
}

export function normalizeStrictJsonSchema(schema: unknown): Record<string, unknown> {
    const normalized = normalizeJsonSchemaValue(schema);
    if (!isRecord(normalized)) {
        throw new ProxyValidationError('output_config.format.schema must be a JSON object.');
    }
    return normalized;
}

function normalizeJsonSchemaValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(normalizeJsonSchemaValue);
    }
    if (!isRecord(value)) {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        result[key] = normalizeJsonSchemaValue(child);
    }

    if (isRecord(result.properties)) {
        result.required = Object.keys(result.properties);
        if (result.additionalProperties === undefined) {
            result.additionalProperties = false;
        }
    }
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveReasoningEffort(
    request: Pick<AnthropicMessageRequest, 'output_config' | 'thinking'>,
    proxyDefault: CodexReasoningEffort,
): CodexReasoningEffort {
    if (request.output_config?.effort !== undefined) {
        return normalizeEffort(request.output_config.effort, 'output_config.effort');
    }

    if (request.thinking !== undefined) {
        if (request.thinking.type === 'disabled') {
            return 'none';
        }
        if (request.thinking.budget_tokens !== undefined) {
            return effortFromThinkingBudget(request.thinking.budget_tokens);
        }
        return proxyDefault;
    }

    return proxyDefault;
}

export function systemPromptToInstructions(system: AnthropicSystemPrompt | undefined): string {
    if (system === undefined) {
        return '';
    }
    if (typeof system === 'string') {
        return system;
    }
    return system.map((block) => block.text).join('\n\n');
}

function buildInstructions(request: AnthropicMessageRequest): string {
    return systemPromptToInstructions(request.system);
}

function translateMessages(request: AnthropicMessageRequest): CodexInputItem[] {
    const input: CodexInputItem[] = [];

    for (const [messageIndex, message] of request.messages.entries()) {
        if (message.role === 'system') {
            input.push(...translateSystemMessage(message.content as AnthropicSystemPrompt));
            continue;
        }
        if (message.role === 'user') {
            input.push(...translateUserMessage(message.content));
            continue;
        }
        input.push(...translateAssistantMessage(message.content, messageIndex));
    }

    return input;
}

function translateSystemMessage(content: AnthropicSystemPrompt): CodexInputItem[] {
    const text = systemPromptToInstructions(content);
    if (text.length === 0) {
        return [];
    }
    return [
        {
            role: 'developer',
            content: [{ type: 'input_text', text }],
        },
    ];
}

function translateUserMessage(content: AnthropicMessageRequest['messages'][number]['content']): CodexInputItem[] {
    if (typeof content === 'string') {
        return [
            {
                role: 'user',
                content: [{ type: 'input_text', text: content }],
            },
        ];
    }

    const items: CodexInputItem[] = [];
    const pendingContent: CodexInputContent[] = [];
    const flushPendingContent = () => {
        if (pendingContent.length === 0) {
            return;
        }
        items.push({
            role: 'user',
            content: [...pendingContent],
        });
        pendingContent.length = 0;
    };

    for (const block of content as AnthropicUserContentBlock[]) {
        if (block.type === 'text') {
            pendingContent.push({
                type: 'input_text',
                text: block.text,
            });
            continue;
        }

        if (block.type === 'image') {
            pendingContent.push({
                type: 'input_image',
                detail: 'auto',
                image_url: block.source.type === 'base64' ? `data:${block.source.media_type};base64,${block.source.data}` : block.source.url,
            });
            continue;
        }

        flushPendingContent();
        items.push(translateToolResult(block));
    }

    flushPendingContent();
    return items;
}

function translateAssistantMessage(content: AnthropicMessageRequest['messages'][number]['content'], messageIndex: number): CodexInputItem[] {
    if (typeof content === 'string') {
        return [createAssistantTextItem(content, messageIndex, 0)];
    }

    return (content as AnthropicAssistantContentBlock[]).flatMap((block, blockIndex): CodexInputItem[] => {
        if (block.type === 'text') {
            return [createAssistantTextItem(block.text, messageIndex, blockIndex)];
        }
        if (block.type === 'thinking') {
            return [decodeReasoningSignature(block.signature)];
        }
        if (block.type === 'redacted_thinking') {
            return [decodeReasoningSignature(block.data)];
        }
        if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result') {
            return [];
        }

        return [translateToolUse(block)];
    });
}

function createAssistantTextItem(text: string, messageIndex: number, blockIndex: number): CodexAssistantMessageItem {
    return {
        type: 'message',
        role: 'assistant',
        id: `msg_ccx_replay_${messageIndex}_${blockIndex}`,
        status: 'completed',
        content: [
            {
                type: 'output_text',
                text,
                annotations: [],
            },
        ],
    };
}

function translateToolUse(block: AnthropicAssistantContentBlock): CodexFunctionCallItem {
    if (block.type !== 'tool_use') {
        throw new ProxyValidationError(`Unsupported assistant content block type "${block.type}".`);
    }

    const identity = decodeToolId(block.id);
    return {
        type: 'function_call',
        id: identity.item,
        call_id: identity.call,
        name: block.name,
        arguments: JSON.stringify(block.input),
    };
}

function translateToolResult(block: AnthropicUserContentBlock): CodexFunctionCallOutputItem {
    if (block.type !== 'tool_result') {
        throw new ProxyValidationError(`Unsupported user content block type "${block.type}".`);
    }

    return {
        type: 'function_call_output',
        call_id: decodeToolId(block.tool_use_id).call,
        output: toolResultOutput(block),
    };
}

function toolResultOutput(block: AnthropicToolResultBlock): string {
    if (block.content === undefined) {
        return '';
    }
    if (typeof block.content === 'string') {
        return block.content;
    }
    return block.content.map(toolResultContentBlockToString).join('\n');
}

function toolResultContentBlockToString(block: AnthropicToolResultContentBlock): string {
    if (isToolResultTextBlock(block)) {
        return block.text;
    }
    if (isToolResultImageBlock(block)) {
        return `[image omitted: ${block.source.type === 'base64' ? block.source.media_type : 'url'}]`;
    }
    const type = typeof block.type === 'string' ? block.type : 'unknown';
    return `[unsupported content block omitted: ${type}]`;
}

function isToolResultTextBlock(block: AnthropicToolResultContentBlock): block is AnthropicToolResultContentBlock & { type: 'text'; text: string } {
    return block.type === 'text' && typeof block.text === 'string';
}

function isToolResultImageBlock(block: AnthropicToolResultContentBlock): block is AnthropicToolResultContentBlock & {
    type: 'image';
    source: { type: 'base64'; media_type: string } | { type: 'url' };
} {
    if (block.type !== 'image' || !isRecord(block.source)) {
        return false;
    }
    if (block.source.type === 'url') {
        return typeof block.source.url === 'string';
    }
    return block.source.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string';
}

function translateTools(tools: AnthropicTool[]): OpenAIResponseTool[] {
    return tools.map((tool) => (isAnthropicWebSearchTool(tool) ? translateWebSearchTool(tool) : translateFunctionTool(tool)));
}

function translateFunctionTool(tool: AnthropicFunctionTool): OpenAIResponseTool {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        strict: null,
    } as OpenAIResponseTool;
}

function translateWebSearchTool(tool: AnthropicWebSearchTool): OpenAIResponseTool {
    const translated: Record<string, unknown> = {
        type: 'web_search',
        external_web_access: false,
        search_content_types: ['text', 'image'],
    };
    const filters: Record<string, unknown> = {};
    if (tool.allowed_domains !== undefined && tool.allowed_domains.length > 0) {
        filters.allowed_domains = tool.allowed_domains;
    }
    if (tool.blocked_domains !== undefined && tool.blocked_domains.length > 0) {
        filters.blocked_domains = tool.blocked_domains;
    }
    if (Object.keys(filters).length > 0) {
        translated.filters = filters;
    }
    if (tool.user_location !== undefined) {
        translated.user_location = tool.user_location;
    }
    return translated as unknown as OpenAIResponseTool;
}

function normalizeEffort(value: string, field: string): CodexReasoningEffort {
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
        return value;
    }
    if (value === 'max') {
        return 'xhigh';
    }
    if (value === 'none' || value === 'off' || value === 'disabled') {
        return 'none';
    }
    throw new ProxyValidationError(`${field} must be one of low, medium, high, xhigh, max, or none.`);
}

function effortFromThinkingBudget(budgetTokens: number): CodexReasoningEffort {
    if (budgetTokens <= 4096) {
        return 'low';
    }
    if (budgetTokens <= 16_384) {
        return 'medium';
    }
    if (budgetTokens <= 32_768) {
        return 'high';
    }
    return 'xhigh';
}
