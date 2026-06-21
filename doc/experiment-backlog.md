# Compatibility Experiment Backlog

This file tracks possible future proxy experiments that are **not** current implementation decisions.

## Candidate experiments

- `service_tier` passthrough
  - The public Responses surface appears to support it, but Codex-specific behavior has not been validated strongly enough yet.

- Structured `tool_result` replay
  - Preserve text / image / file outputs structurally instead of flattening to text markers.
  - Only worth doing if a real Claude Code workflow needs the extra fidelity.

- Richer refusal and stop-reason mapping
  - Investigate whether Codex responses can be translated into a more Anthropic-like stop-reason surface without introducing misleading semantics.

- Additional Anthropic content blocks
  - Re-evaluate blocks such as `document`, `search_result`, or other non-Claude-Code request shapes if live usage appears.

- `max_tokens: 0`
  - Validate directly against the deployed Codex endpoint before considering any support or emulation.

- `service_tier`, `container`, or other fields that exist in public OpenAI Responses docs but may not behave the same on the Codex endpoint
  - Treat public docs as hints only; require endpoint-specific verification.

## Promotion rule

Move an item out of this backlog only when it has concrete live-use demand, direct endpoint validation, or both.