import type { CodexCredentials } from './auth.ts';

export const OPENAI_BETA_RESPONSES_SSE = 'responses=experimental';
export const OPENAI_BETA_RESPONSES_WEBSOCKETS = 'responses_websockets=2026-02-06';

export function buildSseHeaders(credentials: CodexCredentials, sessionId: string): Headers {
    const headers = buildBaseHeaders(credentials);
    headers.set('OpenAI-Beta', OPENAI_BETA_RESPONSES_SSE);
    headers.set('accept', 'text/event-stream');
    headers.set('content-type', 'application/json');
    headers.set('session-id', sessionId);
    headers.set('x-client-request-id', sessionId);
    return headers;
}

export function buildWebSocketHeaders(credentials: CodexCredentials, requestId: string): Headers {
    const headers = buildBaseHeaders(credentials);
    headers.set('OpenAI-Beta', OPENAI_BETA_RESPONSES_WEBSOCKETS);
    headers.set('session-id', requestId);
    headers.set('x-client-request-id', requestId);
    return headers;
}

function buildBaseHeaders(credentials: CodexCredentials): Headers {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${credentials.token}`);
    headers.set('chatgpt-account-id', credentials.accountId);
    headers.set('originator', 'pi');
    headers.set('User-Agent', `claude-codex (${process.platform} ${process.arch})`);
    return headers;
}
