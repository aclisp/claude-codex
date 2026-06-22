const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const TOKEN_HIGHLIGHT_THRESHOLD = 10_000;

const USE_COLOR = process.env.NO_COLOR !== '1' && (process.stdout.isTTY || process.stderr.isTTY || process.env.FORCE_COLOR === '1');

export function colorize(value: string, color: string): string {
    if (!USE_COLOR) {
        return value;
    }
    return `${color}${value}${RESET}`;
}

export function formatNotice(level: 'info' | 'warn' | 'error', message: string): string {
    const timestamp = colorize(formatLocalTimestamp(new Date()), GRAY);
    return `${timestamp} ${formatLevelLabel(level)} ${message}`;
}

export function formatLogEvent(level: 'info' | 'warn' | 'error', event: Record<string, unknown>): string {
    const timestamp = colorize(formatLocalTimestamp(event.at), GRAY);
    const fields = formatCompactFields(event);

    return [timestamp, formatLevelLabel(level), ...fields].join(' ');
}

function formatLevelLabel(level: 'info' | 'warn' | 'error'): string {
    const color = level === 'error' ? RED : level === 'warn' ? YELLOW : GREEN;
    return colorize(level.toUpperCase(), `${BOLD}${color}`);
}

function formatCompactFields(event: Record<string, unknown>): string[] {
    const fields: string[] = [];
    const orderedKeys: string[] = [
        'route',
        'status',
        'model',
        'sessionId',
        'transport',
        'stopReason',
        'inputTokens',
        'outputTokens',
        'cacheReadInputTokens',
        'error',
        'errorType',
        'errorMessage',
    ];

    for (const key of orderedKeys) {
        const value = event[key];
        if (value !== undefined) {
            fields.push(formatField(key, value));
        }
    }

    for (const [key, value] of Object.entries(event)) {
        if (key === 'at' || key === 'latencyMs' || orderedKeys.includes(key) || value === undefined) {
            continue;
        }
        fields.push(formatField(key, value));
    }

    if (event.latencyMs !== undefined) {
        fields.push(formatLatency(event.latencyMs));
    }

    return fields;
}

function formatField(key: string, value: unknown): string {
    switch (key) {
        case 'route':
            return colorize(formatScalar(value), BLUE);
        case 'status':
            return colorize(formatScalar(value), statusColor(value));
        case 'model':
            return colorize(formatScalar(value), CYAN);
        case 'sessionId':
            return `${colorize('session=', GRAY)}${colorize(formatSessionId(value), MAGENTA)}`;
        case 'transport':
            return colorize(formatScalar(value), MAGENTA);
        case 'stopReason':
            return colorize(formatScalar(value), GREEN);
        case 'inputTokens':
            return `${colorize('input=', GRAY)}${colorize(String(value), tokenCountColor(value))}`;
        case 'outputTokens':
            return `${colorize('output=', GRAY)}${colorize(String(value), tokenCountColor(value))}`;
        case 'cacheReadInputTokens':
            return `${colorize('cacheRead=', GRAY)}${colorize(String(value), CYAN)}`;
        case 'error':
            return `${colorize('err=', RED)}${colorize(formatScalar(value), RED)}`;
        case 'errorType':
            return `${colorize('type=', RED)}${colorize(formatScalar(value), YELLOW)}`;
        case 'errorMessage':
            return `${colorize('msg=', RED)}${colorize(formatScalar(value), GRAY)}`;
        default:
            return `${colorize(`${key}=`, GRAY)}${colorize(formatScalar(value), valueColor(value))}`;
    }
}

function formatLatency(value: unknown): string {
    if (typeof value === 'number') {
        return colorize(`${value}ms`, CYAN);
    }
    return `${colorize('latency=', CYAN)}${colorize(formatScalar(value), CYAN)}`;
}

function formatScalar(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (value === null) {
        return 'null';
    }
    return JSON.stringify(value);
}

function valueColor(value: unknown): string {
    if (typeof value === 'number') {
        return CYAN;
    }
    if (typeof value === 'boolean') {
        return MAGENTA;
    }
    if (value === null) {
        return GRAY;
    }
    return YELLOW;
}

function formatSessionId(value: unknown): string {
    const text = typeof value === 'string' ? value : formatScalar(value);
    const trimmed = text.replace(/^(?:ccx_|session[-_]|sid[-_])/, '');
    if (trimmed.length <= 8) {
        return trimmed;
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function formatLocalTimestamp(value: unknown): string {
    const date = normalizeDate(value);
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function normalizeDate(value: unknown): Date {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? new Date() : value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
            return date;
        }
    }

    return new Date();
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

function statusColor(value: unknown): string {
    if (typeof value !== 'number') {
        return GRAY;
    }
    if (value >= 500) {
        return RED;
    }
    if (value >= 400) {
        return YELLOW;
    }
    if (value >= 300) {
        return MAGENTA;
    }
    return GREEN;
}

function tokenCountColor(value: unknown): string {
    if (typeof value !== 'number') {
        return CYAN;
    }
    if (value > TOKEN_HIGHLIGHT_THRESHOLD) {
        return `${BOLD}${YELLOW}`;
    }
    return CYAN;
}
