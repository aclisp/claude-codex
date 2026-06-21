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
    const label = level.toUpperCase();
    const color = level === 'error' ? RED : level === 'warn' ? YELLOW : CYAN;
    return `${colorize(label, `${BOLD}${color}`)} ${message}`;
}

export function formatLogEvent(level: 'info' | 'warn' | 'error', event: Record<string, unknown>): string {
    const timestamp = colorize(String(event.at ?? new Date().toISOString()), GRAY);
    const label = colorize(level.toUpperCase(), `${BOLD}${level === 'error' ? RED : level === 'warn' ? YELLOW : GREEN}`);
    const entries = Object.entries(event)
        .filter(([key, value]) => key !== 'at' && value !== undefined)
        .map(([key, value]) => formatField(key, value));

    return [timestamp, label, ...entries].join(' ');
}

function formatField(key: string, value: unknown): string {
    const keyColor = key === 'status' ? statusColor(value) : key === 'route' ? BLUE : key === 'sessionId' ? MAGENTA : key === 'latencyMs' ? CYAN : GRAY;
    return `${colorize(`${key}=`, keyColor)}${formatValue(key, value)}`;
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

function formatValue(key: string, value: unknown): string {
    if (typeof value === 'string') {
        return colorize(JSON.stringify(value), YELLOW);
    }
    if (typeof value === 'number') {
        if (key === 'inputTokens' || key === 'outputTokens') {
            return colorize(String(value), tokenCountColor(value));
        }
        return colorize(String(value), CYAN);
    }
    if (typeof value === 'boolean') {
        return colorize(String(value), MAGENTA);
    }
    if (value === null) {
        return colorize('null', GRAY);
    }
    return colorize(JSON.stringify(value), GRAY);
}

function tokenCountColor(value: number): string {
    if (value > TOKEN_HIGHLIGHT_THRESHOLD) {
        return `${BOLD}${YELLOW}`;
    }
    return CYAN;
}
