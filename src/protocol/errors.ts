export type AnthropicErrorType =
    | 'invalid_request_error'
    | 'authentication_error'
    | 'permission_error'
    | 'request_too_large'
    | 'rate_limit_error'
    | 'overloaded_error'
    | 'api_error';

export interface AnthropicErrorBody {
    type: 'error';
    error: {
        type: AnthropicErrorType;
        message: string;
    };
}

export class ProxyError extends Error {
    readonly httpStatus: number;
    readonly errorType: AnthropicErrorType;

    constructor(message: string, options?: { httpStatus?: number; errorType?: AnthropicErrorType }) {
        super(message);
        this.name = 'ProxyError';
        this.httpStatus = options?.httpStatus ?? 500;
        this.errorType = options?.errorType ?? 'api_error';
    }
}

export class ProxyValidationError extends ProxyError {
    constructor(message: string) {
        super(message, { httpStatus: 400, errorType: 'invalid_request_error' });
        this.name = 'ProxyValidationError';
    }
}

export function isProxyError(error: unknown): error is ProxyError {
    return error instanceof ProxyError;
}

export function toAnthropicErrorBody(error: ProxyError | Error): AnthropicErrorBody {
    if (isProxyError(error)) {
        return {
            type: 'error',
            error: {
                type: error.errorType,
                message: error.message,
            },
        };
    }

    return {
        type: 'error',
        error: {
            type: 'api_error',
            message: error.message || 'Internal proxy error',
        },
    };
}

export function assertValid(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new ProxyValidationError(message);
    }
}
