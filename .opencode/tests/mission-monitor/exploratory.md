# Mission Monitor — Exploratory Test Suite

Feature domain: `mission-monitor`. Unscripted edge/failure probes for Spec #2711 (per-message token counts vs opencode session context).
Run beyond the scripted functional cases. A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

Conventions: ID prefix `E-`. Record expected vs actual; mark `FAIL` with repro if behavior is wrong.

## Probe prompts

- [ ] E-1: **Single-message session.** Run exactly one message. The session-cumulative total equals that message's usage by definition — confirm the node still shows the correct per-message value and the "per-message vs cumulative" distinction is not broken at N=1.

- [ ] E-2: **Tool-heavy turn.** Send a message that triggers many tool calls (bash/read/grep). The delta on the meter may jump with tool span usage. Verify the node's count matches only the message's `gen_ai.usage.*` span values — tool execution spans must not be folded into the chat node's count.

- [ ] E-3: **Session near the context limit.** Long session where the meter approaches the model's context window. Does the meter plateau/max? Does reconciliation (AC3) still hold, and is any residual explained? Probe whether node values degrade when the meter maxes out.

- [ ] E-4: **Concurrent sessions.** Two Run CLI sessions active. Verify node token values from session A never appear on session B's nodes (per-session isolation of per-message counts).

- [ ] E-5: **Meter units mismatch.** If the opencode meter displays non-token units (percent, chars), document the conversion to tokens and verify node values still match the span-level usage (the authoritative per-message source).

- [ ] E-6: **Session restart / new session.** After ending a session and starting a new one, new nodes carry fresh per-message counts — no carryover from the previous session's cumulative total.

- [ ] E-7: **Subagent session tokens.** Dispatch a @-subagent; confirm child-session tokens appear on the child node (if rendered) and do not inflate the parent node's per-message count (Spec #523 compositing).
