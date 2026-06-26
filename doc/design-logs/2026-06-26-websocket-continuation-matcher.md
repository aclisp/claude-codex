## Design Log

### 2026-06-26 WebSocket Continuation Matcher TODO

Live token diagnostics showed no successful `websocketContinuation=delta` requests in a long Claude Code session. The proxy repeatedly logged `websocketContinuation=full` with `sentInputTokens` equal to `translatedInputTokens`, which means the WebSocket continuation matcher failed and the proxy sent the full translated request body. OpenAI prompt cache often absorbed the large stable prefix, but cache misses still produced large input-token spikes.

The current matcher was copied from Pi Agent, but this proxy has an additional Anthropic round trip. Pi stores `lastResponseItems` after converting its own assistant output through the same Responses-message conversion path used for the next request. This proxy currently stores raw OpenAI output items from `response.output_item.done`, while the next turn is rebuilt from Anthropic history into synthetic Codex replay items. Those representations can be semantically identical but byte-different, for example because assistant message ids change from upstream ids to `msg_ccx_replay_*`.

#### TODO Plan

1. Improve `getCachedWebSocketInputDelta` so it compares normalized replay semantics instead of raw JSON identity for assistant output items.
2. Keep exact matching for non-input request fields such as model, instructions, tools, tool choice, reasoning, text config, and prompt cache key.
3. Normalize assistant text messages by role, status, and output text content; ignore replay-only message ids.
4. Normalize function calls by `call_id`, `name`, and `arguments`; tolerate item-id differences only when the call identity is otherwise stable.
5. Normalize reasoning items only when their proxy-owned reasoning signature decodes to the same Responses reasoning item.
6. Continue dropping hosted web-search server/result blocks consistently, because request translation does not replay them into Codex input.
7. Add a diagnostic for full-continuation misses, such as `websocketContinuationMiss=body_changed|input_shorter|prefix_mismatch`, to verify the matcher improvement in live runs.
8. Add tests covering assistant text replay id mismatch, tool-use replay, unchanged request-body fields producing delta, changed tools/instructions producing full, and compacted/truncated history producing full.

#### Recommendation

Start with a conservative normalizer in the continuation matcher. This is lower risk than redesigning response capture and directly targets the observed `prefix_mismatch` class. If normalization becomes too broad or fragile, switch to storing explicit replay-shaped response items, equivalent to Pi Agent storing converted response items rather than raw upstream output items.

Status: TODO, experiment backlog.
