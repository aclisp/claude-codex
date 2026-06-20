import { ProxyValidationError } from '../protocol/errors.ts';

export const CODEX_MODEL_IDS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;
export type CodexModelId = (typeof CODEX_MODEL_IDS)[number];

export interface CodexModelCatalogItem {
    id: CodexModelId;
    supportsImages: true;
}

export const DEFAULT_CODEX_MODEL_ID: CodexModelId = 'gpt-5.4-mini';

export const CODEX_MODEL_CATALOG: readonly CodexModelCatalogItem[] = CODEX_MODEL_IDS.map((id) => ({
    id,
    supportsImages: true,
}));

export function isCodexModelId(value: string): value is CodexModelId {
    return CODEX_MODEL_IDS.includes(value as CodexModelId);
}

export function validateCodexModelId(value: unknown): CodexModelId {
    if (typeof value !== 'string') {
        throw new ProxyValidationError(`Model must be one of: ${CODEX_MODEL_IDS.join(', ')}.`);
    }

    if (!isCodexModelId(value)) {
        throw new ProxyValidationError(
            `Unsupported model "${value}". Supported Codex models are: ${CODEX_MODEL_IDS.join(', ')}. Configure Claude Code model mapping to one of these ids.`,
        );
    }

    return value;
}
