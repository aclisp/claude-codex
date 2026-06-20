import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function createMessageId(): string {
    return `msg_ccx_${randomToken(16)}`;
}

export function createRequestId(): string {
    if (typeof randomUUID === 'function') {
        return randomUUID();
    }
    return `ccx_${randomToken(16)}`;
}

export function shortHash(value: string, length = 32): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function randomToken(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
}
