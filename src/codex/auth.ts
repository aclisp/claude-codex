import { readFile, stat } from 'node:fs/promises';
import { ProxyError } from '../protocol/errors.ts';

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

        const auth = parseCodexAuth(parsed);
        if (!auth.accessToken) {
            throw new ProxyError(
                `Codex file-backed auth is required, but ${this.authPath} does not contain tokens.access_token. Keyring-only auth is unsupported in v1.`,
                {
                    httpStatus: 401,
                    errorType: 'authentication_error',
                },
            );
        }

        if (!auth.accountId) {
            throw new ProxyError(`Codex auth file at ${this.authPath} does not contain tokens.account_id. Keep Codex running or run codex login.`, {
                httpStatus: 401,
                errorType: 'authentication_error',
            });
        }

        this.cached = {
            token: auth.accessToken,
            accountId: auth.accountId,
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

function parseCodexAuth(value: unknown): { accessToken?: string; accountId?: string } {
    const root = asRecord(value);
    if (!root) {
        return {};
    }

    const tokens = asRecord(root.tokens);
    const accessToken = tokens?.access_token;
    const accountId = tokens?.account_id;

    return {
        accessToken: typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined,
        accountId: typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined,
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
