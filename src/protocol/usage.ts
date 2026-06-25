export interface InternalUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    webSearchRequests?: number;
}

export interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    server_tool_use?: {
        web_search_requests?: number;
    };
}

export function toAnthropicUsage(usage?: InternalUsage): AnthropicUsage {
    const result: AnthropicUsage = {
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
    };

    if (usage?.cacheReadInputTokens !== undefined) {
        result.cache_read_input_tokens = usage.cacheReadInputTokens;
    }
    if (usage?.webSearchRequests !== undefined && usage.webSearchRequests > 0) {
        result.server_tool_use = {
            web_search_requests: usage.webSearchRequests,
        };
    }

    return result;
}
