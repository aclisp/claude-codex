## Design Log

### 2026-06-25 Basic Hosted Web Search

Basic Anthropic hosted web search, `web_search_20250305`, is proxied to OpenAI Responses hosted `web_search`. This slice intentionally covers basic search enablement, domain filters, approximate user location, named web-search forcing, tolerance for replayed server-search result blocks, and Anthropic-visible server-tool/result blocks for completed Codex searches.

Do not emulate Anthropic `max_uses` locally in v1. It is accepted and validated so Claude Code requests do not fail, but it is not forwarded because Responses does not expose a search-call count cap. `search_context_size` controls result context volume, not the number of searches. Approximate `user_location` is forwarded because both Anthropic and OpenAI expose compatible hosted-search location semantics. Do not support newer Anthropic web-search variants until dynamic filtering and response-inclusion behavior are explicitly designed.

Completed OpenAI `web_search_call` output items are converted to Anthropic `server_tool_use` and `web_search_tool_result` blocks before the final text. Search result entries are synthesized from URLs and markdown links in the final text, matching the behavior verified in `claude-code-proxy`. The proxy also reports `usage.server_tool_use.web_search_requests`.
