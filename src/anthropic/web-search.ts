export interface AnthropicWebSearchResult {
    type: 'web_search_result';
    title: string;
    url: string;
    encrypted_content?: string;
    page_age?: string | null;
}

export interface AnthropicWebSearchToolResultError {
    type: 'web_search_tool_result_error';
    error_code: string;
}

export function serverToolUseIdFromCodexWebSearchId(id: string | undefined): string {
    const suffix = (id || crypto.randomUUID()).replace(/[^A-Za-z0-9_]/g, '_');
    return `srvtoolu_${suffix}`;
}

export function extractWebSearchResultsFromText(text: string): AnthropicWebSearchResult[] {
    const results = new Map<string, AnthropicWebSearchResult>();
    for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
        const title = cleanTitle(match[1] ?? '');
        const url = cleanUrl(match[2] ?? '');
        if (!url || results.has(url)) {
            continue;
        }
        results.set(url, { type: 'web_search_result', title: title || fallbackTitle(url), url });
    }

    for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/g)) {
        const url = cleanUrl(match[0] ?? '');
        if (!url || results.has(url)) {
            continue;
        }
        const title = titleNearUrl(text, match.index ?? 0, url);
        results.set(url, { type: 'web_search_result', title: title || fallbackTitle(url), url });
    }

    return [...results.values()];
}

function cleanUrl(value: string): string {
    let result = value.trim();
    while (/[.,;:!?]$/.test(result)) {
        result = result.slice(0, -1);
    }
    try {
        return new URL(result).toString();
    } catch {
        return '';
    }
}

function titleNearUrl(text: string, urlStart: number, url: string): string {
    const nearbyLines = text
        .slice(0, urlStart)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.includes('http'))
        .slice(-3)
        .reverse();
    for (const line of nearbyLines) {
        const title = cleanTitle(line);
        if (title.length > 0) {
            return title;
        }
    }
    return fallbackTitle(url);
}

function cleanTitle(value: string): string {
    const noListMarker = value
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .trim();
    const [prefix] = noListMarker.split(/\s(?:-|\u2013|\u2014)\s/);
    return (prefix ?? noListMarker).trim();
}

function fallbackTitle(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}
