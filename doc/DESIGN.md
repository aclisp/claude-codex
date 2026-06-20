# Claude Code to Codex Proxy Design

## Goal

Build a localhost-only compatibility proxy that lets Claude Code use a Codex subscription as the upstream model backend. Claude Code talks to the proxy as if it were the Anthropic Messages API. The proxy translates requests to the OpenAI Codex Responses API and translates Codex responses back into Anthropic-compatible responses.

This is not a general Anthropic API emulator. The target client is Claude Code only.

## References

- `pi-agent-docs.md` points to the Pi docs and source. Pi's Codex provider is the golden implementation reference for Codex auth, request construction, streaming, prompt-cache affinity, and WebSocket behavior.
- `claude-api-ref.md` points to the Anthropic Messages API docs.
- `openai-api-ref.md` points to the OpenAI Responses API docs.
- Pi source reference paths:
  - `/Users/homerh/Code/pi/packages/ai/src/providers/openai-codex-responses.ts`
  - `/Users/homerh/Code/pi/packages/ai/src/providers/openai-responses-shared.ts`
  - `/Users/homerh/Code/pi/packages/ai/src/providers/openai-prompt-cache.ts`
  - `/Users/homerh/Code/pi/packages/ai/src/utils/oauth/openai-codex.ts`

## V1 Scope

V1 exposes only the Anthropic-compatible surface Claude Code needs:

- `POST /v1/messages`
- `GET /v1/models` if Claude Code probes it

V1 does not implement `/v1/messages/count_tokens` unless Claude Code proves it needs that endpoint. Token counting is intentionally deferred because Anthropic and OpenAI accounting differ, especially with tools, images, reasoning, and prompt caching.

V1 supports both streaming and non-streaming responses. Streaming is the primary path.

## Non-Goals

- Full Anthropic API compatibility.
- Proxy-side compaction or summarization.
- Durable conversation/session persistence.
- Keyring-backed Codex auth.
- Public network serving.
- Exact Anthropic prompt-cache semantics.
- Exact Anthropic thinking-block compatibility.
- File/PDF/document inputs.
- Named forced tool choice unless later proven necessary.

## Security Model

The proxy binds only to `127.0.0.1` in v1. It rejects non-loopback bind configuration.

Claude Code sends a dummy Anthropic API key to the proxy. The proxy never forwards that key upstream.

The proxy owns upstream Codex auth but only as a read-only consumer. It reads file-backed Codex credentials from `CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`. It does not write or refresh credentials. Codex CLI/app is expected to stay open and keep tokens fresh.

V1 requires Codex file-backed auth. Keyring-backed auth is unsupported and should fail with a clear local error.

Credential rules:

- Never log token fields.
- Never log `auth.json` contents.
- Re-read `auth.json` before each upstream request, or cache briefly and re-read when mtime changes.
- On upstream 401/403, re-read `auth.json` once and retry once.
- If auth remains unavailable or rejected, return an Anthropic-style auth error telling the user to keep Codex running or run `codex login`.

## Architecture

Implement as a standalone Node/TypeScript service. Do not import Pi internals at runtime. Copy or adapt the narrow Pi Codex provider logic with attribution.

Suggested modules:

- HTTP server and route dispatch.
- Anthropic request parser and validator.
- Anthropic response/SSE encoder.
- Codex auth reader.
- Codex request builder.
- Codex SSE/WebSocket transports.
- Codex Responses stream processor.
- Session and WebSocket cache.
- Tool id encoder/decoder.
- Error mapper.
- Static model catalog.
- Logging and diagnostics.

## Codex Transport

Align with Pi:

- Try Codex WebSocket first.
- Fall back to SSE only if WebSocket fails before any response events are emitted.
- If WebSocket fails after streaming starts, fail that request rather than switching mid-response.
- Mark a session as SSE-only after a WebSocket transport failure.
- Keep per-session WebSocket cache and continuation state.
- Use `previous_response_id` plus input deltas when safe.
- Evict idle WebSocket/session state after about 5 minutes.
- If the same session has overlapping requests, open a temporary extra WebSocket instead of reusing a busy one.

On client disconnect, abort the upstream fetch or close the upstream WebSocket. Do not cache continuation state for incomplete responses.

## Session Identity

The proxy needs a stable session id for:

- Codex `prompt_cache_key`.
- WebSocket cache lookup.
- Request affinity headers.
- Continuation state.

Prefer a Claude Code-provided session/request header if one exists. Otherwise derive a stable in-memory id per detected Claude Code conversation, for example from process/cwd/request context. Never generate a new random id per request.

Session state is in memory only. After proxy restart, Claude Code's resent history is translated into a full-context Codex request.

## Codex Request Shape

Follow Pi's Codex Responses request shape:

- `store: false`
- `stream: true`
- `instructions` from the Anthropic `system` prompt
- `input` from translated message history
- `include: ["reasoning.encrypted_content"]`
- `prompt_cache_key` from the stable session id, clamped to OpenAI's prompt-cache key limit
- `tool_choice: "auto"` by default
- `parallel_tool_calls: true`
- `text.verbosity` defaulting to a conservative value

Do not include the system prompt again in Responses `input`.

## System Prompt Mapping

Anthropic `system` may be:

- A string.
- An array of text blocks.

Map both to Codex `instructions`. For block arrays, concatenate text blocks in order with blank lines. Strip `cache_control`. Reject non-text system blocks in v1.

## Message Mapping

Translate Claude Code's resent history every request:

- User text -> Responses `input_text`.
- User base64 image blocks -> Responses `input_image` data URLs.
- Assistant text -> Responses assistant message items.
- Assistant `tool_use` -> Responses function-call items using the encoded tool id.
- User `tool_result` -> Responses `function_call_output`.

Preserve assistant text exactly. Reject unsupported assistant block types that could alter tool state.

## Image Support

V1 supports Anthropic base64 image blocks in user messages:

```json
{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}
```

Map them to Responses `input_image` data URLs when the selected Codex model supports images. Reject URL, file, PDF, and document blocks in v1.

Tool-result images are deferred unless Claude Code actually sends them.

## Tool Mapping

Anthropic tools map to OpenAI function tools:

- `name` preserved.
- `description` preserved.
- `input_schema` -> function `parameters`.
- Use non-strict schema mode, aligned with Pi's Codex provider.
- Do not mutate schemas to satisfy OpenAI strict mode.

Enable parallel tool calls.

Tool choice:

- Omitted or `auto` -> Codex auto.
- `any` -> Codex auto in v1.
- `none` -> disable tools for that request if sent.
- Named forced tool -> reject in v1 unless later proven necessary.

## Tool Id Format

OpenAI Responses has both `call_id` and function-call item `id`. Anthropic exposes one `tool_use.id`. The proxy must make Anthropic tool ids self-contained so replay survives proxy restarts.

Use a versioned base64url payload with a proxy prefix:

```text
ccx_<base64url({"v":1,"call":"...","item":"..."})>
```

Rules:

- Decode `tool_result.tool_use_id` back to OpenAI `call_id`.
- Decode prior assistant `tool_use.id` back to function-call identity during history replay.
- Reject malformed proxy-generated ids with a clear 400.
- Do not rely on side maps for correctness.
- No HMAC is required for localhost-only v1.

## Streaming Response Mapping

V1 must emit Anthropic-compatible SSE, not OpenAI event names.

Minimum event sequence:

- `message_start`
- For each content block:
  - `content_block_start`
  - zero or more `content_block_delta`
  - `content_block_stop`
- `message_delta` with final `stop_reason` and usage
- `message_stop`

Text deltas map to Anthropic `text_delta`.

Tool argument deltas map to Anthropic `input_json_delta`. Buffer tool JSON internally and validate the final object at block stop. Preserve streamed JSON delta text where possible and do not reformat JSON mid-stream.

If an error occurs before streaming begins, return an Anthropic-style JSON error. If streaming has already begun, emit an Anthropic `error` SSE event.

## Non-Streaming Response Mapping

For `stream: false`, collect the internal translated assistant message and return an Anthropic-style message JSON response. This path should share the same Codex stream processor as the streaming path.

## Stop Reasons

Map stop reasons explicitly:

- Codex text completion -> `end_turn`
- Codex function calls -> `tool_use`
- Codex incomplete/max tokens -> `max_tokens`
- Codex refusal text -> `end_turn`
- Upstream auth/rate/context/internal errors -> Anthropic-style error response
- Client abort -> cancel upstream and close the stream; do not fake success

## Error Mapping

Return Anthropic-style JSON errors for handled failures:

- 400 invalid request -> `invalid_request_error`
- 401/403 Codex auth unavailable/rejected -> `authentication_error` or `permission_error`
- 413 local body too large -> `request_too_large`
- 429 Codex usage/rate limit -> `rate_limit_error`
- 503/529 upstream overload -> `overloaded_error`
- Context overflow -> `invalid_request_error` with a message that clearly includes context-length exceeded semantics
- Internal proxy bug -> `api_error`

Do not mask usage-limit or auth failures as generic 500s.

## Prompt Caching

Accept Anthropic `cache_control` markers without failing, but do not try to emulate Anthropic prompt-cache breakpoints. Strip those markers before building Codex input.

Use OpenAI/Codex caching independently via stable session `prompt_cache_key`.

Keep stable prompt/tool material before variable conversation content to maximize prefix-cache hits.

Only report cache usage if it can be derived honestly from Codex usage, such as OpenAI `cached_tokens`. Otherwise leave cache fields absent or zero.

## Reasoning and Effort

V1 uses Claude Code effort controls as a convenient way to set Codex reasoning effort. V1 does not expose Codex reasoning as Anthropic thinking blocks.

Control precedence:

1. `output_config.effort`
2. `thinking`
3. Proxy default

Recommended mapping:

- `low` -> Codex `low`
- `medium` -> Codex `medium`
- `high` or omitted -> Codex `high` or proxy default
- `xhigh` -> Codex `xhigh`
- `max` -> Codex `xhigh`
- `thinking.type === "disabled"` -> Codex reasoning off/none if supported
- `thinking.type === "enabled"` with only `budget_tokens` -> convert budget bands to effort levels, not exact token budgets

V1 requests `reasoning.encrypted_content` upstream and may preserve Codex reasoning items internally for Responses continuity, but it suppresses Anthropic `thinking` and `redacted_thinking` blocks in responses.

V2 can evaluate reasoning-block compatibility if it can preserve Anthropic-like signature semantics honestly.

Claude Code ultracode mode receives no special proxy behavior. If it sends an API-visible `xhigh` signal, map that to Codex `xhigh`. Harness-level orchestration remains Claude Code's responsibility.

## Request Parameters

Map only the safe common subset:

- `max_tokens` -> Codex max output token option.
- `temperature` -> Codex temperature option.
- `metadata` -> local only; do not send upstream.
- `stop_sequences` -> unsupported in v1 if non-empty.
- `top_p` and `top_k` -> unsupported in v1 if non-default.

Return clear 400s for unsupported non-default parameters instead of silently changing behavior.

## Beta Headers

Accept Anthropic beta headers from Claude Code, but do not forward them upstream. Ignore known harmless beta flags. Reject request-body features that v1 does not support.

Set Codex-required `OpenAI-Beta` headers independently, aligned with Pi.

## Model Catalog

Use a static default model catalog aligned with Pi's Codex model metadata. Do not dynamically discover models in v1.

The proxy advertises only actual Codex-backed model ids it can use. It does not silently map arbitrary Claude model names.

Claude Code model-name mapping should live in `/Users/homerh/.claude/settings.json`. The proxy docs should provide recommended mappings. If Claude Code sends an unknown model, return a clear invalid request error listing supported model ids and pointing to the mapping recommendation.

The default model should track Pi's current OpenAI Codex default unless overridden by proxy config.

## Logging and Diagnostics

Default logs are metadata-only:

- timestamp
- route
- model
- session id
- transport
- status
- latency
- stop reason
- token usage
- cache read tokens
- error class

Do not log request bodies, response bodies, tool outputs, auth headers, or tokens by default.

Optional body tracing may be added with an explicit local path, for example `--debug-bodies <path>`. It must redact sensitive fields and print a startup warning.

## Persistence

Persist nothing across restarts in v1 except optional config and logs.

In-memory only:

- WebSocket cache
- continuation state
- response ids
- request/session state
- tool JSON buffers

Tool ids must be self-contained so Claude Code's resent history remains decodable after restart.

## Testing Strategy

Tests should use mocked Anthropic requests and mocked Codex SSE/WebSocket events.

Core test groups:

- Anthropic request parsing and validation.
- System/message/image/tool schema conversion.
- Tool id encode/decode and restart replay.
- Codex request body construction.
- Anthropic SSE event sequencing.
- Tool argument delta streaming and final JSON validation.
- WebSocket-first behavior and pre-event SSE fallback.
- Session isolation and busy-session concurrency.
- Auth reader behavior without logging secrets.
- Error mapping.
- Stop reason mapping.
- Non-streaming response collection.

Use Pi provider tests as a behavioral reference where applicable, but do not depend on Pi internals at runtime.

## V2 Candidates

- Anthropic thinking/redacted-thinking compatibility for Codex reasoning summaries or encrypted reasoning.
- Keyring-backed Codex auth.
- Durable session diagnostics.
- `/v1/messages/count_tokens` if Claude Code needs it.
- More complete model discovery.
- File/PDF/document block support.
- Tool-result image support.
- Optional local proxy bearer token.
- Public binding behind explicit dangerous flags and additional auth.
