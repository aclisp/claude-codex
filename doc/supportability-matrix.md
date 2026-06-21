# Anthropic Compatibility Final Decisions

## Purpose

This document records the current compatibility decisions for the Claude Code -> Codex proxy.

It is intentionally conservative:

1. **Live Codex-verified behavior wins** over theoretical public OpenAI Responses compatibility.
2. **Current working proxy behavior stays in place** unless there is strong evidence that a change improves real Claude Code compatibility.
3. Public OpenAI Responses docs and SDK types are useful for finding candidates, but they are **not sufficient by themselves** to justify a proxy behavior change when the Codex deployment behaves differently.

## Adopted now

These items are approved for implementation because they are low-risk, directly supported by the current translator structure, and explicitly desired by the user.

- `tool_choice.disable_parallel_tool_use: true`
  - Decision: support it.
  - Proxy behavior: translate to Responses `parallel_tool_calls: false` while leaving the existing default as `true` when the flag is absent.

- User image URL blocks
  - Decision: support them.
  - Proxy behavior: accept Anthropic user image blocks with `source.type: "url"` in addition to existing base64 image blocks, and translate them to Responses `input_image.image_url`.

## Keep as-is

These behaviors are already live-validated or intentionally conservative and should remain unchanged for now.

- `max_tokens`
  - Keep requiring and validating it on the Anthropic side.
  - Do **not** forward it upstream as `max_output_tokens` in this Codex deployment.

- `stop_sequences`
  - Keep accepting and validating `string[]`.
  - Do **not** forward it upstream.
  - Do not add proxy-side stop-sequence emulation at this time.

- `temperature`
  - Keep forwarding it upstream as currently implemented.

- `top_p` and `top_k`
  - Keep rejecting non-default values.

- Tool-result replay
  - Keep the current stable string/marker behavior for nested multimodal or unsupported tool-result content.

- `/v1/models`
  - Keep the current static Codex-backed model catalog.

- Reasoning / thinking compatibility
  - Keep the current proxy-owned reasoning-signature approach for Claude Code continuity.
  - Do not expand this into a claim of full Anthropic thinking-block compatibility.

## Explicitly unsupported or deferred

These items are not final implementation decisions today.

- `service_tier` passthrough
  - Public Responses compatibility exists in theory, but there is not yet enough Codex-specific evidence to change behavior.

- Anthropic `container`
  - Current semantics do not line up cleanly with the proxy’s current Codex usage.

- Additional Anthropic request content blocks such as `document`, `search_result`, and similar non-Claude-Code inputs
  - No current live need.

- Richer stop-reason / refusal mapping
  - Potentially useful, but not yet prioritized over current stable behavior.

- Structured `tool_result` replay instead of current text flattening
  - Potentially possible, but not yet justified by live Claude Code behavior.

- `max_tokens: 0`
  - Not enough evidence that the current Codex deployment accepts a safe equivalent.

## Decision rule for future changes

A compatibility item should move from backlog to implementation only when at least one of these is true:

- Claude Code actually needs it in live use.
- Codex behavior has been verified directly against the deployed endpoint.
- The change is small, low-risk, and clearly improves compatibility without disturbing validated behavior.

## Related documents

- `doc/anthropic-to-openai-responses-fixes.md` — implemented translation fixes grounded in live behavior.
- `doc/DESIGN.md` — current design and behavior notes.
- `doc/experiment-backlog.md` — open experiments and future investigation items.
