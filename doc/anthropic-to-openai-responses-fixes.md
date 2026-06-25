# Anthropic to OpenAI Responses Translation Fixes

This note summarizes request translation fixes made after commit
`1c63faaa57836bb1d2267f28ae50544326e06c1c`, which introduced the v1 proxy
runtime.

## Implemented Behavior

- `max_tokens` is no longer forwarded as `max_output_tokens`, which Codex
  Responses does not accept.
- Default Codex reasoning effort is `medium`.
- `context_management` is accepted and ignored instead of rejected.
- `stop_sequences` is accepted and validated as `string[]`, but intentionally
  not forwarded upstream.
- Top-level Claude `system` maps to Responses `instructions`.
- Claude message-level `role: "system"` maps to Responses `developer` input
  messages instead of being folded into `instructions`.
- Claude `{ type: "any" }` tool choice maps to Responses `required`.
- Claude named tool choice `{ type: "tool", name }` maps to Responses
  `{ type: "function", name }`.
- Claude `tool_choice.disable_parallel_tool_use: true` maps to Responses
  `parallel_tool_calls: false`.
- Missing, `null`, or malformed `tools[].input_schema` is normalized to
  `{ type: "object", properties: {} }`.
- Basic hosted web search tools, `web_search_20250305`, map to Responses
  hosted `web_search`. Non-empty domain filters and approximate
  `user_location` are forwarded. `max_uses` is accepted and validated but not
  forwarded because Responses has no search-count cap equivalent.
- Completed Codex web-search calls emit Anthropic `server_tool_use` and
  `web_search_tool_result` blocks, with
  `usage.server_tool_use.web_search_requests`.
- `output_config.format` with `json_schema` maps to Responses `text.format`,
  with strict schema normalization.
- `thinking.type: "adaptive"` is accepted.
- Claude thinking and redacted thinking blocks can be replayed into Responses
  reasoning items through proxy-owned signatures.
- Assistant tool calls replay through encoded proxy tool IDs.
- Tool results map back to `function_call_output`.
- Nested tool-result images or unknown blocks no longer fail translation; they
  become stable text markers such as `[image omitted: image/png]` or
  `[unsupported content block omitted: thinking]`.
- Base64 user images translate to Responses `input_image` data URLs.
- User image URL blocks translate to Responses `input_image` URLs.

## Main Files

- `src/anthropic/request.ts`
- `src/codex/request.ts`
- `src/codex/count-tokens.ts`
- `src/translation.test.ts`

## Intentionally Deferred

- Newer hosted web search variants beyond basic `web_search_20250305`,
  including dynamic filtering and response-inclusion controls.
- `service_tier` passthrough.
