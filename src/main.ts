import { CodexAuthReader } from './codex/auth.ts';
import { CodexClient } from './codex/client.ts';
import { createProxyServer } from './http/server.ts';
import { loadRuntimeConfig } from './runtime/config.ts';
import { createSessionStore } from './sessions/store.ts';

const config = loadRuntimeConfig();

if (config.debugBodiesPath) {
    console.warn(`Debug body tracing enabled at ${config.debugBodiesPath}. Sensitive fields are redacted by key name only.`);
}

const authReader = new CodexAuthReader(config.authPath);
const codexClient = new CodexClient({
    baseUrl: config.codexBaseUrl,
    authReader,
    websocketConnectTimeoutMs: config.websocketConnectTimeoutMs,
    upstreamIdleTimeoutMs: config.upstreamIdleTimeoutMs,
});
const proxyServer = createProxyServer(config, {
    codexClient,
    sessionStore: createSessionStore(config.stateDir),
});

const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: proxyServer.fetch,
});

console.info(`claude-codex listening on http://${server.hostname}:${server.port}`);

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
