import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { shortHash } from '../runtime/id.ts';

export interface SessionRecord {
    id: string;
    createdAt: number;
    lastSeenAt: number;
    claudeHeader?: string;
    fingerprint: string;
}

export interface SessionResolution {
    sessionId: string;
    record: SessionRecord;
}

export class SessionStore {
    private records = new Map<string, SessionRecord>();
    private loaded = false;

    constructor(private readonly statePath: string) {}

    async resolve(headers: Headers): Promise<SessionResolution> {
        await this.load();

        const claudeHeader = findClaudeSessionHeader(headers);
        const fingerprint = claudeHeader ? `header:${claudeHeader}` : buildFallbackFingerprint(headers);
        const existing = this.records.get(fingerprint);
        const now = Date.now();

        if (existing) {
            existing.lastSeenAt = now;
            await this.save();
            return {
                sessionId: existing.id,
                record: existing,
            };
        }

        const record: SessionRecord = {
            id: `ccx_${shortHash(fingerprint, 32)}`,
            createdAt: now,
            lastSeenAt: now,
            fingerprint,
        };
        if (claudeHeader) {
            record.claudeHeader = claudeHeader;
        }

        this.records.set(fingerprint, record);
        await this.save();
        return {
            sessionId: record.id,
            record,
        };
    }

    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;

        let raw: string;
        try {
            raw = await readFile(this.statePath, 'utf8');
        } catch {
            return;
        }

        try {
            const parsed = JSON.parse(raw) as { sessions?: SessionRecord[] };
            for (const record of parsed.sessions ?? []) {
                if (isSessionRecord(record)) {
                    this.records.set(record.fingerprint, record);
                }
            }
        } catch {
            this.records.clear();
        }
    }

    async save(): Promise<void> {
        await mkdir(dirname(this.statePath), { recursive: true });
        const sessions = [...this.records.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 200);
        await writeFile(
            this.statePath,
            `${JSON.stringify(
                {
                    version: 1,
                    sessions,
                },
                null,
                2,
            )}\n`,
            'utf8',
        );
        this.records = new Map(sessions.map((record) => [record.fingerprint, record]));
    }
}

export function createSessionStore(stateDir: string): SessionStore {
    return new SessionStore(resolve(stateDir, 'sessions.json'));
}

function findClaudeSessionHeader(headers: Headers): string | undefined {
    const names = ['x-claude-session-id', 'anthropic-session-id', 'x-session-id', 'x-client-request-id', 'x-request-id'];
    for (const name of names) {
        const value = headers.get(name);
        if (value && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function buildFallbackFingerprint(headers: Headers): string {
    const cwd = headers.get('x-claude-code-cwd') ?? headers.get('x-workspace-path') ?? headers.get('x-cwd') ?? 'unknown-cwd';
    const userAgent = headers.get('user-agent') ?? 'unknown-agent';
    return `fallback:${cwd}:${userAgent}`;
}

function isSessionRecord(value: unknown): value is SessionRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as SessionRecord;
    return (
        typeof record.id === 'string' && typeof record.fingerprint === 'string' && typeof record.createdAt === 'number' && typeof record.lastSeenAt === 'number'
    );
}
