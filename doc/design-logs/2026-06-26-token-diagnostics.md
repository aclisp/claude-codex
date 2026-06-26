## Design Log

### 2026-06-26 Token Diagnostics

Token diagnostics are intentionally log-only. They help distinguish three cases without changing request translation or upstream transport behavior:

- Claude Code or the proxy sent a large translated request.
- WebSocket continuation sent only a small delta while upstream usage still reported a large input number.
- Hosted web search added hidden upstream context.

`translatedInputTokens` estimates the full translated Codex request before transport optimizations. `sentInputTokens` and `sentInputItems` estimate the actual request body sent upstream after transport handling. For WebSocket requests, `websocketContinuation` records whether the request used no continuation state, fell back to a full request after a continuation mismatch, or sent only an input delta.

Diagnostics are controlled by `CLAUDE_CODEX_TOKEN_DIAGNOSTICS` or `--token-diagnostics`:

- `off` / `0`: never add token diagnostic fields.
- `threshold` / `1`: default behavior. Add diagnostics only for hosted web-search requests, input tokens at or above 10000, or cache-miss inputs at or above 5000.
- `all`: add diagnostics on every successful `/v1/messages` log.

Keep these fields threshold-gated by default. They are operational diagnostics for live investigation, not part of the Anthropic compatibility surface.
