import { DEFAULT_CODEX_BASE_URL } from '../runtime/config.ts';

export function resolveCodexUrl(baseUrl?: string): string {
    const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
    const normalized = raw.replace(/\/+$/, '');
    if (normalized.endsWith('/codex/responses')) {
        return normalized;
    }
    if (normalized.endsWith('/codex')) {
        return `${normalized}/responses`;
    }
    return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
    const url = new URL(resolveCodexUrl(baseUrl));
    if (url.protocol === 'https:') {
        url.protocol = 'wss:';
    } else if (url.protocol === 'http:') {
        url.protocol = 'ws:';
    }
    return url.toString();
}
