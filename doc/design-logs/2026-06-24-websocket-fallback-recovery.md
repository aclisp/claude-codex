## Design Log

### 2026-06-24 WebSocket Fallback Recovery

Real Claude Code testing showed that once a session logged a WebSocket-to-SSE fallback, later requests for that session never attempted WebSocket again. The root cause was a process-local permanent fallback marker keyed by session id.

Adopt a per-session cooldown instead of permanent SSE-only state:

- A WebSocket failure records cooldown state for that session.
- Requests during cooldown use SSE directly so Claude Code keeps working.
- After cooldown expires, the next request may try WebSocket again.
- Repeated failures may back off up to a bounded maximum.
- A successful WebSocket response clears the cooldown.

Recovery should not run as a background probe. It should happen only on a later request, after the previous WebSocket connection is no longer usable. In userland, the observable disconnection signals are WebSocket `close`, `error`, connect timeout, or abort; raw TCP state is not inspected directly.

Do not replay a request through SSE after any upstream WebSocket event has already been seen. That request may have produced partial model output, so replaying it risks duplicate or divergent behavior. Instead, fail that request, mark the session cooldown, and let the next request use SSE or retry WebSocket according to the cooldown state.

Preserve the existing user-facing fallback diagnostic behavior. Emit the existing `codex_transport_fallback` log whenever a WebSocket-path failure changes the session's transport state, even if the failed request itself cannot safely replay to SSE. The log is meant to reduce user confusion more than to model the internal replay boundary exactly. Do not add separate cooldown, retry, or restored event names unless real operational need appears.

Do not filter failure types before recording fallback state. Any error observed on the WebSocket path should record cooldown and emit the fallback diagnostic. This preserves prior behavior and avoids surprising users with an unexplained switch to SSE.
