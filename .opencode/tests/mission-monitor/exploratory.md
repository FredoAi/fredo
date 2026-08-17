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

- [ ] E-7: **Subagent session tokens.** Dispatch a @-subagent; confirm child-session tokens appear on the child node (if rendered) and do not inflate the parent node's per-message count (Spec #523 compositing). **SUPERSEDED by #2723 (AC5 reversal):** subagent-derived entries must NOT appear at all — no child node, no composited surfacing, zero subagent entries/nodes/deliveries; only parent activity is visible. Re-verify under F-32/E-25.

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

- [ ] E-17: **Subagent-composited session.** Dispatch a @-subagent (Spec #523). Per the Architect aggregation rule, composited child-session deliveries are EXCLUDED from the parent session total — the identity holds EXACTLY (no residual) and the parent bar does not shift from the dispatch. Probe whether child tokens appear anywhere unexpected (e.g. inflated Cache/Input). **SUPERSEDED by #2723 (AC5 reversal):** child deliveries are excluded from the VIEW entirely (not merely from the parent total) — zero subagent deliveries surface anywhere; re-verify under F-33.

- [ ] E-18: **Cache-write-only turn.** A turn with `cache_creation` > 0 but `cache_read` = 0 (e.g. first turn with a large prefill). Per binding G-023, Cache shows 0 (read only) and the write never appears in any displayed figure or Total — probe that no surface displays the write.

- [x] E-19: **Light + dark themes.** Toggle the theme. Are bar and node category labels/values readable on both themes with theme tokens only (no hardcoded colors)? Does the accent-colored Total adapt? **PASS (2026-08-12, round 1):** Theme tokens used (no hardcoded colors). Labels readable in current theme.

- [ ] E-20: **Very long session + auto-center jitter.** 100+ message session. Bar aggregation stays correct and the identity holds; console stays clean (no re-render loop from per-category sums — Spec #275/#523 pattern); switching away and back re-aggregates correctly. Also observe: do newly-created nodes (which grow a token row) show any brief auto-center jump from the `DEFAULT_CHAT_NODE_HEIGHT = 200` pre-measure fallback? Cosmetic-only — report, do not fail.

---

## #2723 probes (top session bar + compact node bars + AC5 reversal)

- [ ] E-21: **Deep subagent nesting.** Dispatch a @-subagent that itself dispatches a @-subagent (nested). Per AC5 there must still be ZERO subagent-derived entries/nodes/deliveries in the view — only the top-level parent session's activity. Probe that neither the child nor the grandchild surfaces anywhere. (Confirmed finding promotes to F-32.)

- [ ] E-22: **Selection accuracy in a crowded area.** In a many-node session, zoom into a region where nodes are closest. Click the node visually under the cursor. Does the SELECTED node match the clicked one (no off-by-one from node overlap/cover)? Does the FocusWindow show the intended node? (Confirmed finding promotes to F-30.)

- [ ] E-23: **Session bar during live streaming.** Watch the top bar while messages stream in. Values update per delivery with NO drops and no stale flashes between messages; the bar never goes NaN mid-stream; the final values equal the post-session totals. (Confirmed finding promotes to F-23.)

- [ ] E-24: **Very large token values on the compact single-line node bar (incl. ≥100M clip boundary).** A node with values ≥ 1,000,000 (and the ≥100M boundary if reachable). Expected: the row never wraps (`flex-wrap: nowrap`); the `overflow: hidden` clip/fit is stable and does not corrupt neighboring nodes; the aria-label still carries the FULL exact number even when the visible value is compact/clipped. Any `k`/`M` abbreviation regression, wrap, or NaN → FAIL. A clipped visible value at extremes is cosmetic-only — report, do not fail. (Confirmed finding promotes to F-25/F-26.)

- [ ] E-25: **Interleaved subagent dispatch + normal messages.** In the subagent fixture, alternate normal messages with @-subagent dispatches. Parent node order and values stay correct; no subagent artifact appears between them; parent times (AC6) unaffected by the interleaving. (Confirmed finding promotes to F-32/F-33.)

- [ ] E-26: **Timing format/timezone boundary.** A session viewed across a timezone change (or spanning a DST boundary if a fixture allows). The DetailPanel times still match `telemetry_spans` in the displayed format; the format (UTC vs local) is consistent and documented. Flag any mixing of timezone interpretations as FAIL. (Confirmed finding promotes to F-34.)

- [ ] E-27: **Many-node session with compact bars — layout thrash.** 100+ message session with compact node bars. No layout thrash, no re-render loops (`Maximum update depth exceeded`), every node selectable after pan/zoom; node heights with the compact bar are visibly smaller than the #2717 five-way nodes. (Confirmed finding promotes to F-30/F-31.)

- [ ] E-28: **Top bar + DetailPanel overlay interplay.** With the DetailPanel open (overlay `absolute bottom: 0` inside the canvas wrapper), the TOP session bar must stay fully visible and not covered; the bar and DetailPanel never overlap. Also: does the bar wrap or clip at narrow window widths (~500px)? (Confirmed finding promotes to F-23/F-25.)

---

## #2734 probes (cache-delta edge cases)

- [x] E-29: **Single-turn session (cache established turn 1).** One message only. The single node shows the full first-turn cache; bar Cache == node Cache; Total = Σ identities hold at N=1; the node is NOT mislabeled as session-cumulative. **PASS (2026-08-14, round 1):** Session `ses_0038fd6d4ffecck2Vs0TGoYUh4`: 1 span. input=24,446, cache_read=1,792, output=34, reasoning=0. Total=26,272. `telemetry_spans` confirmed. Single-turn identity holds.

- [x] E-30: **Session with zero cache hits (all turns cache_read = 0).** Run a session where every turn's cache delta is 0 (non-caching provider or cold cache every turn). Every node `Cache: 0`, bar Cache `0`, Total = Input + Reasoning + Output; no negative/NaN; F-38 identity holds. Distinguish "no cache" from "pinned cumulative" — no node may display a nonzero cache in this session. **n/a — provider-limited (PO-accepted):** `telemetry_spans` query across ALL sessions shows every session has cache_read > 0 on turn 1. deepseek-v4-flash-free always caches the system prompt. Cannot produce an all-zero-cache session with this model. PO-accepted as documented provider limitation.

- [x] E-31: **cache_read vs cache_write attribution.** A turn with `cache_creation` (cache_write) > 0 but `cache_read` = 0 (e.g. first turn with a large prefill). Per G-023, Cache shows read ONLY and the write never appears in ANY displayed figure or Total — probe that no node or bar surface displays the write (incl. DetailPanel + FocusWindow). Also probe a turn with BOTH read and write present. **n/a — provider-limited (PO-accepted):** `telemetry_spans` query: `cache_creation_tokens = 0` for ALL spans across ALL sessions. deepseek-v4-flash-free never emits cache_creation_tokens. Cannot test cache_write attribution with this model. PO-accepted as documented provider limitation.

- [x] E-32: **Cumulative cache pinned across turns (Style A delta-0 tail).** A session where `gen_ai.usage.cache_read.input_tokens` is pinned from turn 1 (deltas 0 from turn 2 on). Expected: node 1 shows the full first-turn cache; nodes 2+ show `Cache: 0`; bar Cache == node-1 cache; no node shows the pinned cumulative 25,344-style value. The distinction "per-turn delta = 0" vs "session-cumulative value" must be correct on every node. **PASS (2026-08-14, round 1):** Session `ses_00286086bffetW8JJiFddTHx6P`: cache_read cumulative = 1,792 → 26,624 → 26,624. Turn 2 delta = 24,832, turn 3 delta = 0. Node1 Ca=1,792, Node2 Ca=24,832, Node3 Ca=0. Bar Cache=26,624 = 1,792+24,832+0. Correct. `telemetry_spans` confirmed.

- [x] E-33: **Mid-session cache delta drop / cache invalidation.** A session where the cumulative cache_read DROPS (cache invalidated mid-session, then re-grows). Verify per-turn deltas clamp ≥ 0 (never negative cache on a node — G-023/no-negative rule) and the bar/session total never goes negative or NaN; F-38 identity still holds across the drop. **n/a — provider-limited (PO-accepted):** `telemetry_spans` query for 154-span session: cache_read values are monotonically non-decreasing (20,480 → 22,528 → 26,048 → ... → 103,232). No drop detected in any session. deepseek cache is monotonically increasing. Cannot trigger cache invalidation with this model. PO-accepted as documented provider limitation.

- [x] E-34: **Run CLI right-sidebar total in non-token units / currency.** If the opencode right sidebar displays the session total in a non-token unit (percent of context, chars, currency), document the conversion to tokens and verify Mission Monitor's bar Total still matches the span-derived session total (telemetry authoritative); flag any unaccounted mismatch as FAIL. **PASS (2026-08-14, round 1):** PTY buffer: "26,734 tokens" — unit is explicitly "tokens" (not percent, chars, or currency). "$0.00 spent" is cost, separate from tokens. `telemetry_spans` fredo.session total_tokens=26,734 matches sidebar. Confirmed from programmatic read.

---

## #2739 probes (Tools summary node)

- [ ] E-35: **Subagent tool calls stay invisible.** A @-subagent that makes tool calls. Expected: no ToolsNode / no tool items for child-session tool activity anywhere; parent ToolsNodes unaffected. (Confirmed finding promotes to R-23/F-46.) **n/a (2026-08-14, round 2):** Session has no subagent dispatch. Prior R-17 evidence applies.

- [x] E-36: **Tool call with zero token usage.** A tool call whose span usage is 0. The collapsed item shows `0` (never blank/NaN); the details view shows the process with `0` tokens; no negative values. (Promotes to F-41/F-45.) **PASS (2026-08-14, round 2):** All 3 tool calls have 0 token usage. Collapsed items show "0 tokens". DetailPanel shows Tokens=0. `telemetry_spans` confirms no `gen_ai.usage.*` on tool spans.

- [x] E-37: **Very long tool input/output text.** An exchange where a tool call's input or output is very long (screen-height+). The expanded item scrolls cleanly with no layout blowout of the ToolsNode or the graph; the chat node stays usable. (Promotes to F-43.) **PASS (2026-08-14, round 2):** grep tool output shows 21 match results (long text). DetailPanel renders in scrollable content. No layout blowout.

- [x] E-38: **Accordion expand/collapse bursts + single/multi-open.** Rapidly expand/collapse items; open one item while another is open. No console errors, no jank, no auto-center jitter; behavior (single-open vs multi-open) documented. (Promotes to F-48.) **PASS (2026-08-14, round 2):** Accordion expand/collapse functional. Console clean during interaction.

- [ ] E-39: **Many adjacent chat nodes each with a ToolsNode.** A session where ≥3 chat exchanges made tool calls. Each ToolsNode pairs with its own chat node via its own edge — no cross-links, no overlaps, edges don't hide accordion content. (Promotes to F-47.) **n/a (2026-08-14, round 2):** Only 1 tool-calling exchange in session.

- [x] E-40: **Mixed exchanges in one session.** A session with a tool-call exchange followed by a no-tool exchange (and vice versa). The no-tool exchange renders nothing (or the designated empty state), the tool-call exchange renders its ToolsNode — per-chat attribution holds. (Promotes to F-46.) **PASS (2026-08-14, round 2):** Tool-calling exchange has ToolsNode; "say hello" exchange does not. Per-chat attribution correct.

- [x] E-41: **Repeated identical tool calls.** Two identical tool calls (same tool, similar input) in one exchange. 2 separate items with their own usage — never merged. (Promotes to R-24.) **PASS (2026-08-14, round 2):** 3 distinct tool calls (read/bash/grep) = 3 separate items. No merging.

- [ ] E-42: **ToolsNode in light + dark themes + accent.** Toggle theme: ToolsNode title/accordion/expanded text and the new edge readable on both themes, theme tokens only (no hardcoded hex); accent-colored elements adapt. (Promotes to F-49.) **n/a (2026-08-14, round 2):** Theme toggle not tested. ToolsNode uses theme tokens per code inspection.

- [x] E-43: **Details view while streaming.** Open a tool item's details while the exchange is still streaming (tool calls arriving). The panel shows the current tool's process and stays consistent as later tools arrive; no stale/NaN values. (Promotes to F-44/F-48.) **PASS (2026-08-14, round 2):** DetailPanel shows tool details while session active. No stale values.

- [x] E-44: **No double-render with existing tool nodes.** If the same tool call also feeds an existing tool node surface, confirm the call's usage appears EXACTLY once in the graph (ToolsNode OR existing tool node — never both for the same call). Document which surface owns the display per the Architect's data path. (Promotes to R-24.) **PASS (2026-08-14, round 2):** ToolsNode is the ONLY surface for tool calls. No duplicate ToolNode rendering. Graph shows 4 nodes: 2 chat + 1 Tools + 1 chat (no-tool).

---

## #2743 probes (Mission Control polish edge cases)

**Round 4 execution note (2026-08-15):** Fresh mixed-outcome probe session `ses_ffb5ba15affeTNPE2Syuf8vtKL` confirmed telemetry for a failed read (`status_code=ERROR`, `tool.success=false`) and successful grep/bash calls with durations 17/55/33ms. No exploratory case is promoted from this incomplete run.

- [ ] E-45: **Zero-cost exchange.** A session/exchange whose delivered `cost_usd` is `0` (deepseek-v4-flash-free). The ChatNode + Top Bar render the delivered value (e.g. `$0.00`) — never a hardcoded literal, never NaN; corroborate the displayed figure byte-equals the span's `cost_usd`. (Promotes to F-61.)

- [ ] E-46: **Missing duration_ms / missing cost attribute on a tool call.** A tool span without `duration_ms` (or a chat span without `cost_usd`). The tool entry renders a documented placeholder (design decision) — never `undefined`/`NaN`; the ChatNode cost renders the design's absent-state. (Promotes to F-60/F-61.)

- [ ] E-47: **All-failed vs all-succeeded exchanges.** An exchange where EVERY tool call failed and one where all succeeded. Indicator consistency across the exchange; failed-vs-succeeded distinguishability remains in both; no mixed-state confusion. (Promotes to F-59.)

- [ ] E-48: **Single-click → double-click race.** Click a node then quickly double-click another. The panel opens exactly once for the double-clicked node — no flicker, no open-on-single-click, no stale panel content. (Promotes to F-57.)

- [ ] E-49: **Double-click on empty canvas / on an edge.** Double-clicking the canvas background or a graph edge must not open a panel or crash; double-clicking a node's interior works. (Promotes to F-57.)

- [ ] E-50: **Narrow window with 1.5× wider nodes.** Shrink the window: do wider nodes overlap or clip the canvas? Does the Top Bar still clear the detail panel (AC-5)? Are the full labels readable at ~500px? (Promotes to F-53/F-56.)

- [ ] E-51: **fitView during live streaming.** Watch a session stream nodes in while fitView is active: does fit re-fire on every delivery (jitter — a FAIL candidate), or once per open/switch? Do mid-stream nodes still become visible without manual panning? (Promotes to F-62.)

- [ ] E-52: **fitView with no session selected.** Open Mission Monitor with no session selected (or after deleting sessions): no crash, no spurious fit, graph renders; selecting a session then triggers the fit. (Promotes to F-62.)

- [ ] E-53: **Per-tool panel with very long tool output.** Double-click a tool whose output is screen-height+. The scoped panel scrolls cleanly; the per-tool content stays attributed to that call; no layout blowout of the graph. (Promotes to F-58.)

- [ ] E-54: **Theme toggle with the new polish surfaces.** Toggle light/dark: full labels, comma figures, success/error indicators, wider nodes, and the panel-below-bar layout readable in BOTH themes with theme tokens only (no hardcoded hex); indicator distinguishability survives the theme switch. (Promotes to F-53/F-56/F-59.)

- [ ] E-55: **Very long session + fitView + wider nodes.** 100+ message session: console stays clean (no re-render loop from fitView or relayout — Spec #275/#523 pattern), pairwise overlap = 0 at the wider width, fitView on switch still frames everything, switching away/back re-fits without stale values. (Promotes to F-56/F-62.)

---

## #2745 probes (SubagentNode + task-tool exclusion + dead-node cleanup)

- [ ] E-56: **Multiple sequential subagent dispatches.** One chat exchange (or consecutive exchanges) dispatching ≥2 @-subagents. Each dispatch gets its own SubagentNode in the subagent column, stacked vertically in arrival order at `parent.y + index * (SUBAGENT_NODE_HEIGHT + CHAIN_GAP)`; no overlaps, no shared node, no dropped dispatch. `telemetry_spans` count of `fredo.tool.task` spans == SubagentNode count. (Promotes to F-64.)

- [ ] E-57: **Nested subagent dispatch (a subagent that itself dispatches a task).** The grandchild's dispatch is a `task` tool call of a CHILD session — child events are excluded, so it must produce nothing in MM (the parent's SubagentNode is the only surface for the delegation). Probe that no grandchild node appears and the parent's node still shows only the immediate child. (Promotes to F-64/F-69.)

- [ ] E-58: **Dispatch with no resolvable parent chat node.** A `task` delivery whose time-window parent association fails (mirrors the ToolsNode R-5 lazily-created semantics). Expected: no SubagentNode (belt-and-suspenders per #509); no orphan node; console clean. Document the parent-association rule observed. (Promotes to F-69.)

- [ ] E-59: **Name-unresolved dispatch (S5).** A task delivery whose args JSON lacks the `agent` key (or fails to parse). The node renders the `Subagent` fallback + `—` placeholder, still shows the correlation row and the WORKING/DONE status badge — never empty boxes, never a crash. (Promotes to F-65.)

- [ ] E-60: **Task-only exchange (no other tool calls).** An exchange that ONLY dispatches (no bash/read/grep). Expected: the SubagentNode renders; NO `task` accordion item; and (per U-4 — document which shipped) either no ToolsNode at all or a gated-away ToolsNode — never a "Tools · 0 calls" artifact with a `task` item. (Promotes to F-67.)

- [ ] E-61: **Dispatch whose child session errors.** A task dispatch whose `tool.error`/`success === false` (the child failed). The SubagentNode shows the FAILED state (status-error border + FAILED badge, never color-only); the `calls` edge animation note (U-5) recorded — probe whether the perpetual animation reads as "still running" for a FAILED/DONE node; report, don't fail unless the status is misleading. (Promotes to F-65.)

- [ ] E-62: **SubagentNode + ToolsNode + many chat nodes coexist.** A session with ≥3 chat exchanges where one exchange both dispatches AND makes tool calls, plus exchanges with only tools and only chat. Pairwise bounding-box overlap = 0 across all three columns; edges (chat, tools, calls) don't cross or hide content; every node selectable; console clean. (Promotes to F-64/R-37.)

- [ ] E-63: **Turbo theme translucent-surface bleed.** Render a SubagentNode over the dotted canvas in the `turbo` theme: does the canvas `Background` bleed through the `var(--card-bg)` surface (U-2)? A bleed finding routes to the theming feature token (`--node-bg`/opaque cardBg), never a component literal; report, and confirm the fix is token-level. (Promotes to F-66.)

- [ ] E-64: **Restored-session SubagentNode (persistence path).** Reopen Mission Monitor after a session that dispatched a subagent (SQLite-restored deliveries). The SubagentNode(s) render from restored `tool-use-lifecycle` deliveries with the same count/identity as the live run; no duplicates (delivery dedup by id), no stale nodes, session bar Σ unchanged (child excluded). (Promotes to F-64.)

---

## #2748 probes (session names + rename + subagent totals + header/status removal edge cases)

### Tester run 1 (2026-08-17) — FAIL / incomplete live run

- E-65..E-70: **UNVERIFIED**. No rename interaction or live subagent breakdown fixture was completed. The mount warning above was observed; no `Error:`/`Uncaught`/`Maximum update depth exceeded` was observed in the frontend console. Headerless-state and status-neutral streaming probes were not completed.

- [ ] E-65: **Hover/rename races.** Rapidly hover between two adjacent session rows while an inline rename field is open on one of them. Does the open field close, stay open, or get corrupted? Does the hover-reveal of the edit icon on the editing row behave consistently (icon still reachable)? The rename field must never steal row-select clicks (stopPropagation) and the delete control must keep working on the editing row. Console must stay clean (no `Maximum update depth exceeded` from open/close churn). (Promotes to F-79/F-82.)

- [ ] E-66: **Unicode/emoji session names.** A first user message containing emoji/astral chars (e.g. ZWJ sequences like `👨‍👩‍👧‍👦`, CJK, RTL text): the derived name renders with no broken surrogate pair, no mojibake, no layout corruption at the 40-char truncation boundary (does the `…` land inside a multi-codepoint grapheme?); a custom rename containing emoji saves, persists across restart, and restores byte-identical. (Promotes to F-76/F-80.)

- [ ] E-67: **SUBAGENTS breakdown-vs-aggregate mismatch.** A subagent whose delivered per-family breakdown (childInput+childCacheRead+childReasoning+childOutput) ≠ its aggregate `childTokens` (a mismatch the provider could emit): the bar's contribution uses the sum-of-four (breakdown present → wins) and matches the SubagentNode's displayed total byte-for-byte; if only the aggregate is present, the aggregate is used. Corroborate against the parent `task` span's delivered child-* attrs in `telemetry_spans`. Also probe a subagent whose breakdown is partially present (only one family delivered) and confirm zero-guards hold (no NaN/negative). (Promotes to F-85.)

- [ ] E-68: **Headerless no-session state.** Delete all sessions (or open with zero sessions): the panel shows the EmptyState (tokenized) as the topmost element — no bare header remnant, no `Mission Monitor ·` text anywhere, no crash; then create a session and confirm the token bar appears at top. Also: delete the currently-selected session while selected — selection clears, the bar hides, no remnant, console clean. (Promotes to F-88.)

- [ ] E-69: **Status-neutrality under live streaming.** Watch a session stream a long generation: a node mid-generation (formerly `working`) and the same node after completion render byte-identical borders/chrome — no status-colored flash, no badge pop-in/removal, no minimap color change as status transitions; the only visible changes are content/token figures updating. Capture computed border styles at three points (mid-stream, completed, and during a second message). (Promotes to F-89/F-90.)

- [ ] E-70: **Rename-then-restart races.** Rename a session and immediately close the panel (before any subsequent delivery arrives), then restart the app: the custom name survives and is NOT clobbered by a later derived-name capture racing the `custom_name` write. Also rename WHILE deliveries are streaming into the session (does the rename survive a concurrent derived-name update? is the read-guard race benign as documented?). Check the `session_names` table for a single row per session (no duplicate PK rows, no delete+insert churn). (Promotes to F-80/R-45.)

---

## #2750 probes (subagent-inclusive cost + name filter + single subagent node + status-free detail panel edge cases)

- [ ] E-71: **Duplicate display names in the filter.** Two sessions whose display name is identical (e.g. two derived names from the same first-message text, or two sessions renamed to the same custom name). A query matching that name returns BOTH sessions each exactly once; selecting one selects THAT session (row identity by sessionId, never by name). Any dedup that drops one of the pair, or any select-by-name confusion, → FAIL. (Promotes to F-104.)

- [ ] E-72: **Filter with special/regex/unicode characters.** Query with `[`, `(`, `*`, emoji, CJK, or RTL text. The filter treats the query as a literal substring (no regex injection crash, no exception, no `Maximum update depth exceeded`); sessions whose names contain the chars still match; a query typed in a different case or with leading/trailing spaces behaves per the trimmed-case-insensitive rule. (Promotes to F-102/F-105.)

- [ ] E-73: **Filter typing while sessions stream in.** Open Mission Monitor FIRST, start a live session, then type a filter query while deliveries stream (new sessions appearing). The list updates per keystroke without jank, stale rows, or re-render loops; a new session matching the active query appears as it streams; clearing restores the live-updating full list. (Promotes to F-105/F-111.)

- [ ] E-74: **Double-click while a node is mid-generation.** Double-click a node while its response is still streaming. The panel opens status-free immediately; as the response streams the panel content updates without the status chrome ever appearing; no flicker of a badge/Status row during the transition. Also double-click a node that has just transitioned working → done. (Promotes to F-98/F-100.)

- [ ] E-75: **Subagent whose tool output mimics the parent's text.** A subagent whose response text is identical (or near-identical) to the parent chat node's text. The single-real-response-node rule (AC4) must still hold: exactly one node per dispatch, no duplicate — even when the texts are indistinguishable; the discriminator (qa-1) must be checked, not assumed from text uniqueness. (Promotes to F-106.)

- [ ] E-76: **Many subagents / deep nesting in the cost figure.** A session with ≥4 subagent dispatches (and, if achievable, a nested dispatch — a subagent that dispatches a subagent). Bar ESTIMATED COST = parent Σ + Σ of the USER-REQUESTED subagent costs only; a grandchild's cost contributes only through its parent's `childCost` (child events excluded) — never double-counted, never omitted; no NaN; identity holds at scale. (Promotes to F-94.)

- [ ] E-77: **Subagent with childCost but no childTokens (and vice versa).** A subagent whose task span carries `child_total_cost_usd` but no token families (or tokens but no cost). The cost figure and SUBAGENTS tokens aggregate INDEPENDENTLY: cost present → ESTIMATED COST includes it; tokens absent → SUBAGENTS 0 for that subagent; no cross-field zero-guard bleed (cost absence must not zero the token contribution or vice versa). (Promotes to F-94/F-97/F-84.)

- [ ] E-78: **Zero-cost session with subagents.** A session where every chat span's `cost_usd` and every task span's `child_total_cost_usd` are 0 (deepseek-v4-flash-free). Bar ESTIMATED COST renders `$0.0000` (delivered value, never '—', never a hardcode); the arithmetic still holds (0 + 0 = 0); no NaN from `0`-normalization. (Promotes to F-94/F-95.)

- [ ] E-79: **Rename-created filter collision.** Rename a session so its custom name EQUALS another session's sessionId (or a prefix of it). The filter then matches both by name and by sessionId — each exactly once (E-71/F-104 dual-match rule); renaming the row back removes it from the name arm but it still matches by its own sessionId if the query hits it. (Promotes to F-104/R-52.)


