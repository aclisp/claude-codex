import { Buffer } from 'node:buffer';
import type { ResponseReasoningItem } from 'openai/resources/responses/responses.js';
import { ProxyValidationError } from '../protocol/errors.ts';

const REASONING_SIGNATURE_PREFIX = 'ccxrsn_';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface EncodedReasoningSignature {
    v: 1;
    item: ResponseReasoningItem;
}

export function encodeReasoningSignature(item: ResponseReasoningItem): string {
    validateReasoningItem(item);

    const payload: EncodedReasoningSignature = {
        v: 1,
        item,
    };

    return `${REASONING_SIGNATURE_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeReasoningSignature(signature: string): ResponseReasoningItem {
    if (typeof signature !== 'string' || !signature.startsWith(REASONING_SIGNATURE_PREFIX)) {
        throw new ProxyValidationError(`Malformed proxy reasoning signature: expected a signature prefixed with "${REASONING_SIGNATURE_PREFIX}".`);
    }

    const encodedPayload = signature.slice(REASONING_SIGNATURE_PREFIX.length);
    if (!BASE64URL_PATTERN.test(encodedPayload)) {
        throw new ProxyValidationError('Malformed proxy reasoning signature: payload is not valid base64url.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        throw new ProxyValidationError('Malformed proxy reasoning signature: payload is not valid JSON.');
    }

    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.item)) {
        throw new ProxyValidationError('Malformed proxy reasoning signature: payload must contain v and item fields.');
    }

    validateReasoningItem(parsed.item);
    return parsed.item;
}

function validateReasoningItem(value: unknown): asserts value is ResponseReasoningItem {
    if (!isRecord(value) || value.type !== 'reasoning' || typeof value.id !== 'string' || value.id.length === 0 || !Array.isArray(value.summary)) {
        throw new ProxyValidationError('Malformed proxy reasoning signature: reasoning item must contain id, type, and summary fields.');
    }

    for (const summary of value.summary) {
        if (!isRecord(summary) || summary.type !== 'summary_text' || typeof summary.text !== 'string') {
            throw new ProxyValidationError('Malformed proxy reasoning signature: reasoning summary entries must be summary_text blocks.');
        }
    }

    if (value.content !== undefined) {
        if (!Array.isArray(value.content)) {
            throw new ProxyValidationError('Malformed proxy reasoning signature: reasoning content must be an array.');
        }
        for (const content of value.content) {
            if (!isRecord(content) || content.type !== 'reasoning_text' || typeof content.text !== 'string') {
                throw new ProxyValidationError('Malformed proxy reasoning signature: reasoning content entries must be reasoning_text blocks.');
            }
        }
    }

    if (value.encrypted_content !== undefined && value.encrypted_content !== null && typeof value.encrypted_content !== 'string') {
        throw new ProxyValidationError('Malformed proxy reasoning signature: encrypted_content must be a string or null.');
    }

    if (value.status !== undefined && value.status !== 'in_progress' && value.status !== 'completed' && value.status !== 'incomplete') {
        throw new ProxyValidationError('Malformed proxy reasoning signature: status must be in_progress, completed, or incomplete.');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
