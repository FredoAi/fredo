# Mission Monitor regression tests

- [ ] AC4 FIX-FLAT: Verify a no-subagent session has unchanged chat chain node count, positions, edge family, token/history chrome, with only ChatNode section order changed. Capture a current-main baseline when serving-branch guard permits; otherwise document structural fallback and telemetry_spans receipt.
- [ ] AC6 edge contract: Verify e-calls use parent source-right → child target-left and right-side nodes are click-selectable without drag.
- [ ] AC6 theme: Verify node and edge colors remain theme variables in light and dark modes.
- [ ] R-2768-1 Chip zero-state on attributed trees: `unattributedCount === 0` ⇒ chip ABSENT (SessionTokenBar.tsx renders only when N > 0). Round-1 FAIL anchor: `⚠ 2/3 unattributed` from the parent-keyed collector self-map — any re-appearance on an attributed tree is that defect returning. Verified round 2 (F5/F4B/R2A/R2B).
- [ ] R-2768-2 SubagentNode tool starvation shares one root cause with the chip count: if the collector key regresses, BOTH the TOOLS accordion disappears AND the chip counts child tool calls. Assert both together when touching `upsertSubagentActivity`.
- [ ] R-2768-3 Zero duplicate node/edge ids across rapid close/reopen ×2 (NFR-DUPE): identical node-id sets, edge counts, no duplicate-key console warnings. Verified rounds 1 and 2.
- [ ] R-2768-4 Agent node's own tool embedding is independent of the subagent collector (the parent's bash/task calls render in the ChatNode regardless) — the 4a9361e change touched no call sites.
