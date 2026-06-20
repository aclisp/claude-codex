# Claude Code Proxy Usage

This proxy exposes a localhost Anthropic-compatible surface for Claude Code:

- `POST /v1/messages`
- `GET /v1/models`

Start it with:

```bash
bun run start
```

The server binds to `127.0.0.1` by default and refuses non-loopback hosts in v1.

Useful environment variables:

- `CLAUDE_CODEX_PORT`: local proxy port, default `4141`
- `CLAUDE_CODEX_DEFAULT_MODEL`: default Codex model when the request omits one, default `gpt-5.4-mini`
- `CODEX_HOME`: directory containing `auth.json`, default `~/.codex`
- `CODEX_AUTH_PATH`: explicit Codex auth file path
- `CODEX_BASE_URL`: Codex backend base URL, default `https://chatgpt.com/backend-api`

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
