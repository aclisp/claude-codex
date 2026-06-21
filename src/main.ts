import { CodexAuthReader } from './codex/auth.ts';
import { CodexClient } from './codex/client.ts';
import { createProxyServer } from './http/server.ts';
import { formatLogEvent, formatNotice } from './logging.ts';
import { loadRuntimeConfig } from './runtime/config.ts';
import { createSessionStore } from './sessions/store.ts';

const config = loadRuntimeConfig();

if (config.debugBodiesPath) {
    console.warn(formatNotice('warn', `Debug body tracing enabled at ${config.debugBodiesPath}. Sensitive fields are redacted by key name only.`));
}

const authReader = new CodexAuthReader(config.authPath);
const codexClient = new CodexClient({
    baseUrl: config.codexBaseUrl,
    upstreamProxyUrl: config.upstreamProxyUrl,
    authReader,
    websocketConnectTimeoutMs: config.websocketConnectTimeoutMs,
    upstreamIdleTimeoutMs: config.upstreamIdleTimeoutMs,
    onTransportFallback(event) {
        console.warn(
            formatLogEvent('warn', {
                at: new Date().toISOString(),
                event: 'codex_transport_fallback',
                ...event,
            }),
        );
    },
});
const proxyServer = createProxyServer(config, {
    codexClient,
    sessionStore: createSessionStore(config.stateDir),
});

const server = Bun.serve({
    idleTimeout: 0,
    hostname: config.host,
    port: config.port,
    fetch: proxyServer.fetch,
});

console.info(formatNotice('info', `claude-codex listening on http://${server.hostname}:${server.port}`));

process.on('SIGINT', () => {
    codexClient.close();
    server.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    codexClient.close();
    server.stop();
    process.exit(0);
});
