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

Status: partially implemented, still in experiment backlog.

#### 2026-06-27 Partial Implementation Notes

The first implementation chose the fallback direction from the recommendation: store explicit replay-shaped response items rather than raw upstream `response.output_item.done` items. The continuation cache now stores completed assistant text messages, function calls, and reasoning items in Responses input shape, and it skips hosted web-search output items because Anthropic replay drops `server_tool_use` and `web_search_tool_result` blocks when translating back to Codex input.

The matcher also gained a narrow assistant-message comparison rule that ignores assistant message IDs. This is necessary because Anthropic-to-Codex replay still creates synthetic text message IDs such as `msg_ccx_replay_*`, while upstream output messages carry OpenAI-generated IDs such as `msg_*`. This is not a semantic difference for text replay.

Implemented from the TODO plan:

1. Store replay-shaped response items instead of raw output items.
2. Keep exact matching for non-input request fields.
3. Ignore assistant text replay-only IDs during prefix comparison.
4. Continue dropping hosted web-search output items from the continuation baseline.
5. Add tests for replay-shaped item construction and assistant text replay ID mismatch producing `websocketContinuation=delta`.

Not yet implemented:

1. A full structured normalizer for all input item types.
2. Function-call matching by `call_id`, `name`, and `arguments` while tolerating non-semantic item ID differences.
3. Reasoning matching via proxy-owned reasoning signatures instead of exact stored item equality.
4. Miss-reason diagnostics such as `websocketContinuationMiss=body_changed|input_shorter|prefix_mismatch`.
5. Broader tests for changed tools/instructions, tool-use replay, compacted or truncated history, and reasoning replay.

#### 2026-06-27 Live Verification Notes

After the partial implementation, live logs showed successful delta continuation:

```text
translatedInputTokens=90969 sentInputTokens=25354 sentInputItems=1 websocketContinuation=delta
translatedInputTokens=94221 sentInputTokens=25063 sentInputItems=1 websocketContinuation=delta
translatedInputTokens=99485 sentInputTokens=25704 sentInputItems=2 websocketContinuation=delta
```

This confirms the previous "always full" behavior was improved. However, logs still showed intermittent full sends, especially around hosted web-search and tool-use subturns:

```text
translatedInputTokens=95 sentInputTokens=95 sentInputItems=1 webSearchRequests=1
translatedInputTokens=95825 sentInputTokens=95825 sentInputItems=113 websocketContinuation=full
```

The likely cause is continuation baseline overwrite. A tiny hosted web-search side turn can complete successfully and replace the cached continuation anchor with a small request. The next large Claude Code history no longer matches `lastRequestBody.input + lastResponseItems`, so the matcher correctly refuses delta and sends the full translated request.

#### Remaining Plan

1. Add a conservative continuation-update policy. Do not let a tiny side turn replace a much larger long-history continuation baseline.
2. Always allow continuation updates when the request used `websocketContinuation=delta`, because that advances the existing chain.
3. Allow the first successful cached WebSocket request to seed continuation when no previous continuation exists.
4. When a request sends `websocketContinuation=full`, replace the existing baseline only if it appears to be the canonical Claude session history, for example similar or larger input item/token size than the existing baseline.
5. Skip continuation overwrite for hosted web-search-only tiny full requests while still allowing them to use WebSocket transport.
6. Add miss/update diagnostics before tuning the heuristic, ideally distinguishing `no_cached_continuation`, `temporary_busy_socket`, `body_changed`, `input_shorter`, `prefix_mismatch`, and `baseline_update_skipped`.

Recommendation: implement continuation-update gating next, with diagnostics first or in the same patch. The desired behavior is that Claude Code keeps working through hosted web-search side turns without letting those side turns become the long-lived WebSocket continuation anchor.
