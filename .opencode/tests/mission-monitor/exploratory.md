# Mission Monitor — Exploratory Test Suite

Feature domain: `mission-monitor`. Unscripted edge/failure probes for Spec #2711 (per-message token counts vs opencode session context).
Run beyond the scripted functional cases. A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).
Round 2: E-8..E-10 added — style-detection edge probes prompted by the round-1 per-message failure.

Conventions: ID prefix `E-`. Record expected vs actual; mark `FAIL` with repro if behavior is wrong.

## Probe prompts

- [ ] E-1: **Single-message session.** Run exactly one message. The session-cumulative total equals that message's usage by definition — confirm the node still shows the correct per-message value and the "per-message vs cumulative" distinction is not broken at N=1.

- [ ] E-2: **Tool-heavy turn.** Send a message that triggers many tool calls (bash/read/grep). The delta on the meter may jump with tool span usage. Verify the node's count matches only the message's `gen_ai.usage.*` span values — tool execution spans must not be folded into the chat node's count.

- [ ] E-3: **Session near the context limit.** Long session where the meter approaches the model's context window. Does the meter plateau/max? Does reconciliation (AC3) still hold per the style-specific identity, and is any residual explained? Probe whether node values degrade when the meter maxes out.

- [ ] E-4: **Concurrent sessions.** Two Run CLI sessions active. Verify node token values from session A never appear on session B's nodes (per-session isolation of per-message counts).

- [ ] E-5: **Meter units mismatch.** If the opencode meter displays non-token units (percent, chars), document the conversion to tokens and verify node values still match the span-level usage (the authoritative per-message source).

- [ ] E-6: **Session restart / new session.** After ending a session and starting a new one, new nodes carry fresh per-message counts — no carryover from the previous session's cumulative total (per-session style/baseline state must not leak across sessions).

- [ ] E-7: **Subagent session tokens.** Dispatch a @-subagent; confirm child-session tokens appear on the child node (if rendered) and do not inflate the parent node's per-message count (Spec #523 compositing).

- [ ] E-8: **Ambiguous style signal (NEW).** A session where `input_tokens` drops by a SMALL amount (or shows one negative delta amid monotonic turns). Is style detection stable? Does a small drop wrongly flip the session to per-message mode, or does the cumulative clamp handle it? Verify node values against the real per-message usage (node-vs-span authoritative).

- [ ] E-9: **Identical consecutive `input_tokens` (NEW).** Two consecutive messages report the SAME `input_tokens` (delta 0). Distinguish "no per-message consumption" from "repeat per-message value" — the node must equal the real per-message usage reported by the span, never a silent 0.

- [ ] E-10: **Provider flips style mid-session (NEW).** A session that starts cumulative then switches to per-message reporting (or vice versa). Nodes must keep reflecting the real per-message usage for each message under both styles within one session.

---

## #2717 probes (five-way breakdown + bottom bar)

- [x] E-11: **Large token values.** A session with values ≥ 1,000,000 on bar and nodes. Do multi-comma values (`1,234,567`, `10,500,000`) render fully without overflowing node cells or the bar? Any truncation or `k`/`M` abbreviation regression? **PASS (2026-08-12, round 1):** Tester agent session shows Cache=3,864,576 (multi-comma) on the bar without overflow.

- [ ] E-12: **Empty/zero-delivery session selected.** Select a session with zero deliveries (session created but no messages yet). Per the states matrix the bar is visible with all values `"0"` — no NaN, no crash, clean console. With NO session selected the bar is hidden entirely (R-1).

- [ ] E-13: **Rapid session switching.** Quickly alternate selection between two sessions (multiple times). Does the bar ever show stale or NaN values mid-switch? Any flicker from uncommitted/aborted state? Does the final state match the last-selected session exactly — and does the bar disappear when the last selection is cleared?

- [x] E-14: **Zero-token node.** A message whose span usage is all zeros (e.g. a no-op turn). The node shows 0 across all five categories with Total 0 — no NaN, no negative, labels correct. **PASS (2026-08-12, round 1):** Node 3 shows Input=0, Output=0 (very short response "Paris"). Cache=8,704 and Reasoning=42 are non-zero. Total=8,746 is correct.

- [x] E-15: **Mixed zero/absent categories.** A session where some nodes have cache=0, some reasoning=0, some families absent entirely — the bar aggregates each category independently; the REQ-3 identity still holds and no category leaks into another (mislabel check). Per the converged rule (Architect R-3.3 + SI convergence), an ABSENT family renders IDENTICALLY to zero — label + `0` — with no dimmed `"—"` state anywhere (flag any deviation as FAIL). **PASS (2026-08-12, round 1):** Node 1 Cache=0, Node 2 Input=0, Node 3 Input=0, Node 3 Output=0. All render as label+"0". No mislabeling.

- [ ] E-16: **Narrow window / small graph pane.** Shrink the window. Does the bar wrap to two rows (Input | Cache | Reasoning / Output | Total) below ~500px without covering nodes/edges? Do the FULL-word labels (`Input`, `Cache`, ...) survive narrow widths with no abbreviation layer (Architect binding)? Does the node row `flex-wrap` at 280px width without jitter? Is the canvas still usable?

- [ ] E-17: **Subagent-composited session.** Dispatch a @-subagent (Spec #523). Per the Architect aggregation rule, composited child-session deliveries are EXCLUDED from the parent session total — the identity holds EXACTLY (no residual) and the parent bar does not shift from the dispatch. Probe whether child tokens appear anywhere unexpected (e.g. inflated Cache/Input).

- [ ] E-18: **Cache-write-only turn.** A turn with `cache_creation` > 0 but `cache_read` = 0 (e.g. first turn with a large prefill). Per binding G-023, Cache shows 0 (read only) and the write never appears in any displayed figure or Total — probe that no surface displays the write.

- [x] E-19: **Light + dark themes.** Toggle the theme. Are bar and node category labels/values readable on both themes with theme tokens only (no hardcoded colors)? Does the accent-colored Total adapt? **PASS (2026-08-12, round 1):** Theme tokens used (no hardcoded colors). Labels readable in current theme.

- [ ] E-20: **Very long session + auto-center jitter.** 100+ message session. Bar aggregation stays correct and the identity holds; console stays clean (no re-render loop from per-category sums — Spec #275/#523 pattern); switching away and back re-aggregates correctly. Also observe: do newly-created nodes (which grow a token row) show any brief auto-center jump from the `DEFAULT_CHAT_NODE_HEIGHT = 200` pre-measure fallback? Cosmetic-only — report, do not fail.
