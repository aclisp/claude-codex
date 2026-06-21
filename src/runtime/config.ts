import { type CodexModelId, DEFAULT_CODEX_MODEL_ID, validateCodexModelId } from '../codex/models.ts';
import { ProxyValidationError } from '../protocol/errors.ts';

export interface ProxyRuntimeConfig {
    host: string;
    port: number;
    codexBaseUrl: string;
    authPath: string;
    stateDir: string;
    defaultModel: CodexModelId;
    defaultEffort: 'low' | 'medium' | 'high' | 'xhigh';
    textVerbosity: 'low' | 'medium' | 'high';
    maxBodyBytes: number;
    websocketConnectTimeoutMs: number;
    upstreamIdleTimeoutMs: number;
    debugBodiesPath?: string;
}

export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const DEFAULT_PROXY_PORT = 4141;
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

export function loadRuntimeConfig(args: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): ProxyRuntimeConfig {
    const parsedArgs = parseArgs(args);
    const host = parsedArgs.host ?? env.CLAUDE_CODEX_HOST ?? '127.0.0.1';
    assertLoopbackHost(host);

    const port = parsePort(parsedArgs.port ?? env.CLAUDE_CODEX_PORT ?? String(DEFAULT_PROXY_PORT));
    const home = env.HOME ?? process.cwd();
    const codexHome = env.CODEX_HOME ?? `${home}/.codex`;

    return {
        host,
        port,
        codexBaseUrl: parsedArgs.codexBaseUrl ?? env.CODEX_BASE_URL ?? DEFAULT_CODEX_BASE_URL,
        authPath: parsedArgs.authPath ?? env.CODEX_AUTH_PATH ?? `${codexHome}/auth.json`,
        stateDir: parsedArgs.stateDir ?? env.CLAUDE_CODEX_STATE_DIR ?? '.claude-codex',
        defaultModel: validateCodexModelId(parsedArgs.defaultModel ?? env.CLAUDE_CODEX_DEFAULT_MODEL ?? DEFAULT_CODEX_MODEL_ID),
        defaultEffort: parseDefaultEffort(parsedArgs.defaultEffort ?? env.CLAUDE_CODEX_DEFAULT_EFFORT ?? 'medium'),
        textVerbosity: parseTextVerbosity(parsedArgs.textVerbosity ?? env.CLAUDE_CODEX_TEXT_VERBOSITY ?? 'low'),
        maxBodyBytes: parsePositiveInteger(parsedArgs.maxBodyBytes ?? env.CLAUDE_CODEX_MAX_BODY_BYTES ?? String(DEFAULT_MAX_BODY_BYTES), 'max body bytes'),
        websocketConnectTimeoutMs: parsePositiveInteger(
            parsedArgs.websocketConnectTimeoutMs ?? env.CLAUDE_CODEX_WS_CONNECT_TIMEOUT_MS ?? '15000',
            'WebSocket connect timeout',
        ),
        upstreamIdleTimeoutMs: parsePositiveInteger(
            parsedArgs.upstreamIdleTimeoutMs ?? env.CLAUDE_CODEX_UPSTREAM_IDLE_TIMEOUT_MS ?? '0',
            'upstream idle timeout',
        ),
        debugBodiesPath: parsedArgs.debugBodiesPath,
    };
}

function parseArgs(args: string[]): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg?.startsWith('--')) {
            continue;
        }

        const [rawKey = '', inlineValue] = arg.slice(2).split('=', 2);
        const key = rawKey.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
        const value = inlineValue ?? args[index + 1];
        if (inlineValue === undefined) {
            index += 1;
        }
        result[key] = value;
    }

    return result;
}

function assertLoopbackHost(host: string): void {
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') {
        return;
    }
    throw new ProxyValidationError(`Refusing to bind to non-loopback host "${host}" in v1. Use 127.0.0.1.`);
}

function parsePort(value: string): number {
    const port = parsePositiveInteger(value, 'port');
    if (port > 65_535) {
        throw new ProxyValidationError('port must be between 1 and 65535.');
    }
    return port;
}

function parsePositiveInteger(value: string | undefined, field: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new ProxyValidationError(`${field} must be a positive integer.`);
    }
    return parsed;
}

function parseDefaultEffort(value: string): ProxyRuntimeConfig['defaultEffort'] {
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
        return value;
    }
    throw new ProxyValidationError('default effort must be one of low, medium, high, or xhigh.');
}

function parseTextVerbosity(value: string): ProxyRuntimeConfig['textVerbosity'] {
    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }
    throw new ProxyValidationError('text verbosity must be one of low, medium, or high.');
}
