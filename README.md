# claude-codex

A localhost-only proxy that lets Claude Code talk to Codex through an Anthropic-compatible API surface.

## Quickstart

```bash
bun run start
```

By default the proxy binds to `127.0.0.1:4141`.

## Routes

- `POST /v1/messages`
- `GET /v1/models`
- `POST /v1/messages/count_tokens`

## Configuration

### CLI flags

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

### Environment variables

- `CLAUDE_CODEX_HOST`
- `CLAUDE_CODEX_PORT`
- `CODEX_BASE_URL`
- `CODEX_AUTH_PATH`
- `CODEX_HOME`
- `CLAUDE_CODEX_STATE_DIR`
- `CLAUDE_CODEX_DEFAULT_MODEL`
- `CLAUDE_CODEX_DEFAULT_EFFORT`
- `CLAUDE_CODEX_TEXT_VERBOSITY`
- `CLAUDE_CODEX_MAX_BODY_BYTES`
- `CLAUDE_CODEX_WS_CONNECT_TIMEOUT_MS`
- `CLAUDE_CODEX_UPSTREAM_IDLE_TIMEOUT_MS`
- `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`

## Auth

The proxy reads file-backed Codex auth from `auth.json` and never writes or refreshes it. Keep Codex running or run `codex login` when auth expires.

## Supported models

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini` (default)

See `doc/USAGE.md` for a fuller usage guide.
