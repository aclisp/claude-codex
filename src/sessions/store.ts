import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { shortHash } from '../runtime/id.ts';

export const SESSION_STORE_MAX_RECORDS = 200;

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
            this.records = recordsToMap(pruneSessionRecords(this.records.values()));
        } catch {
            this.records.clear();
        }
    }

    async save(): Promise<void> {
        await mkdir(dirname(this.statePath), { recursive: true });
        const sessions = pruneSessionRecords(this.records.values());
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
        this.records = recordsToMap(sessions);
    }
}

export function createSessionStore(stateDir: string): SessionStore {
    return new SessionStore(resolve(stateDir, 'sessions.json'));
}

function findClaudeSessionHeader(headers: Headers): string | undefined {
    const value = headers.get('x-claude-code-session-id');
    if (value && value.length > 0) {
        return value;
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

function pruneSessionRecords(records: Iterable<SessionRecord>): SessionRecord[] {
    return [...records].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, SESSION_STORE_MAX_RECORDS);
}

function recordsToMap(records: Iterable<SessionRecord>): Map<string, SessionRecord> {
    return new Map([...records].map((record) => [record.fingerprint, record]));
}
