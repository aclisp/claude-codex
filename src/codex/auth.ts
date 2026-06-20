import { readFile, stat } from 'node:fs/promises';
import { ProxyError } from '../protocol/errors.ts';

const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

export interface CodexCredentials {
    token: string;
    accountId: string;
    authPath: string;
    mtimeMs?: number;
}

export class CodexAuthReader {
    private cached?: CodexCredentials;

    constructor(private readonly authPath: string) {}

    async read(options?: { force?: boolean }): Promise<CodexCredentials> {
        const mtimeMs = await this.getMtimeMs();
        if (!options?.force && this.cached && this.cached.mtimeMs === mtimeMs) {
            return this.cached;
        }

        let raw: string;
        try {
            raw = await readFile(this.authPath, 'utf8');
        } catch {
            throw new ProxyError(`Codex auth file is unavailable at ${this.authPath}. Keep Codex running or run codex login.`, {
                httpStatus: 401,
                errorType: 'authentication_error',
            });
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new ProxyError(`Codex auth file at ${this.authPath} is not valid JSON. Run codex login again.`, {
                httpStatus: 401,
                errorType: 'authentication_error',
            });
        }

        const token = findToken(parsed);
        if (!token) {
            throw new ProxyError(
                `Codex file-backed auth is required, but ${this.authPath} does not contain a usable token. Keyring-only auth is unsupported in v1.`,
                {
                    httpStatus: 401,
                    errorType: 'authentication_error',
                },
            );
        }

        const accountId = findAccountId(parsed) ?? extractAccountId(token);
        if (!accountId) {
            throw new ProxyError('Codex auth token does not expose a ChatGPT account id. Keep Codex running or run codex login.', {
                httpStatus: 401,
                errorType: 'authentication_error',
            });
        }

        this.cached = {
            token,
            accountId,
            authPath: this.authPath,
            mtimeMs,
        };
        return this.cached;
    }

    private async getMtimeMs(): Promise<number | undefined> {
        try {
            return (await stat(this.authPath)).mtimeMs;
        } catch {
            return undefined;
        }
    }
}

function findToken(value: unknown): string | undefined {
    const root = asRecord(value);
    if (!root) {
        return undefined;
    }

    const candidates = [
        root.id_token,
        root.access_token,
        root.token,
        asRecord(root.tokens)?.id_token,
        asRecord(root.tokens)?.access_token,
        asRecord(root.auth)?.id_token,
        asRecord(root.auth)?.access_token,
    ];

    return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

function findAccountId(value: unknown): string | undefined {
    const root = asRecord(value);
    if (!root) {
        return undefined;
    }

    const candidates = [root.chatgpt_account_id, root.account_id, asRecord(root.tokens)?.chatgpt_account_id, asRecord(root.auth)?.chatgpt_account_id];

    return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

function extractAccountId(token: string): string | undefined {
    try {
        const [, payload] = token.split('.');
        if (!payload) {
            return undefined;
        }
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
        return asRecord(parsed[JWT_CLAIM_PATH])?.chatgpt_account_id as string | undefined;
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
