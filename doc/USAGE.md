# Claude Code Proxy Usage

This proxy exposes a localhost Anthropic-compatible surface for Claude Code backed by Codex:

- `POST /v1/messages`
- `GET /v1/models`
- `POST /v1/messages/count_tokens`

Start it with:

```bash
bun run start
```

The server binds to `127.0.0.1` by default and refuses non-loopback hosts in v1.

Useful CLI flags:

- `--host`
- `--port`
- `--codex-base-url`
- `--auth-path`
- `--state-dir`
- `--default-model`
- `--default-effort`
- `--text-verbosity`
- `--max-body-bytes`
- `--websocket-connect-timeout-ms`
- `--upstream-idle-timeout-ms`
- `--debug-bodies-path`

Useful environment variables:

- `CLAUDE_CODEX_HOST`: local bind host, default `127.0.0.1`
- `CLAUDE_CODEX_PORT`: local proxy port, default `4141`
- `CODEX_BASE_URL`: Codex backend base URL, default `https://chatgpt.com/backend-api`
- `CODEX_AUTH_PATH`: explicit Codex auth file path
- `CODEX_HOME`: directory containing `auth.json`, default `~/.codex`
- `CLAUDE_CODEX_STATE_DIR`: local proxy state directory, default `.claude-codex`
- `CLAUDE_CODEX_DEFAULT_MODEL`: default Codex model when the request omits one, default `gpt-5.4-mini`
- `CLAUDE_CODEX_DEFAULT_EFFORT`: default Codex effort, default `medium`
- `CLAUDE_CODEX_TEXT_VERBOSITY`: default text verbosity, default `low`
- `CLAUDE_CODEX_MAX_BODY_BYTES`: max request body size, default `25 MiB`
- `CLAUDE_CODEX_WS_CONNECT_TIMEOUT_MS`: WebSocket connect timeout, default `15000`
- `CLAUDE_CODEX_UPSTREAM_IDLE_TIMEOUT_MS`: upstream idle timeout, default `0`
- `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`: optional upstream proxy settings for Codex requests

Recommended Claude Code model ids should map directly to one of the proxy catalog ids:

```json
{
  "model": "gpt-5.4-mini"
}
```

Supported v1 model ids:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`

The proxy reads Codex file-backed auth from `auth.json` but never writes or refreshes it. Keep Codex running or run `codex login` when auth expires.
