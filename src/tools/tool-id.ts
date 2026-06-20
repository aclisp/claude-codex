import { Buffer } from 'node:buffer';
import { ProxyValidationError } from '../protocol/errors.ts';

export interface ToolIdentity {
    call: string;
    item: string;
}

const TOOL_ID_PREFIX = 'ccx_';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeToolId(identity: ToolIdentity): string {
    validateToolIdentity(identity);

    const encoded = Buffer.from(
        JSON.stringify({
            v: 1,
            call: identity.call,
            item: identity.item,
        }),
        'utf8',
    ).toString('base64url');

    return `${TOOL_ID_PREFIX}${encoded}`;
}

export function decodeToolId(id: string): ToolIdentity {
    if (typeof id !== 'string' || !id.startsWith(TOOL_ID_PREFIX)) {
        throw new ProxyValidationError(`Malformed proxy tool id: expected an id prefixed with "${TOOL_ID_PREFIX}".`);
    }

    const encodedPayload = id.slice(TOOL_ID_PREFIX.length);
    if (!BASE64URL_PATTERN.test(encodedPayload)) {
        throw new ProxyValidationError('Malformed proxy tool id: payload is not valid base64url.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        throw new ProxyValidationError('Malformed proxy tool id: payload is not valid JSON.');
    }

    if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.call !== 'string' || typeof parsed.item !== 'string') {
        throw new ProxyValidationError('Malformed proxy tool id: payload must contain v, call, and item fields.');
    }

    const identity = {
        call: parsed.call,
        item: parsed.item,
    };
    validateToolIdentity(identity);
    return identity;
}

function validateToolIdentity(identity: ToolIdentity): void {
    if (typeof identity.call !== 'string' || identity.call.length === 0) {
        throw new ProxyValidationError('Tool call id must be a non-empty string.');
    }
    if (typeof identity.item !== 'string' || identity.item.length === 0) {
        throw new ProxyValidationError('Tool item id must be a non-empty string.');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
