# Mission Monitor — Functional Tests (#2706 slice)

> Feature domain: `mission-monitor`. Seeded by QA Expert at #2706 triage. Executed by the Tester;
> evidence for the live-policy plan MUST reference `telemetry_spans` (telemetry-query result).
> IDs: `F-<n>`. One `- [ ]` case per requirement R1–R5 (QA Plan TC rows map 1:1).

## R1 — Token counts formatted with thousands separators (no compact forms)

- [ ] F-1.1 ChatNode bottom-bar token line shows grouped counts — with a token-rich session open, the node bar renders `⬡ 1,234 in / 567 out / 1,801 total`-style values; assert no `k`/`K`/`M` suffix. Edge: 0 → `0`, 999 → `999`, 1,000 → `1,000`, 1,234 → `1,234`, 1,234,567 → `1,234,567` (synthesize ≥1,000,000 via `fredo emit` for the static check).
- [ ] F-1.2 DetailPanel "Token Usage" Prompt / Completion / Total rows use the grouped format (Total recomputed = prompt + completion, DetailPanel.tsx:56).
- [ ] F-1.3 DOM-wide scan: no compact token form (`\d+(\.\d+)?[kK]\b` / `\d+(\.\d+)?M\b` in token-bearing elements) anywhere in the monitor surface (nodes, DetailPanel, headers).
- [ ] F-1.4 Unit contract: `vitest run` (apps/ui) green with `formatTokenCount(1_234_567) === '1,234,567'`, `formatTokenCount(1_234) === '1,234'`, `formatTokenCount(0) === '0'`; old compact assertions in `lib/__tests__/counters.test.ts:261-291` removed/updated.

## R2 — Resizable detail panel; width remembered

- [ ] F-2.1 Drag the panel's left edge → width changes live, sticks on release (no snap-back to 300px).
- [ ] F-2.2 Close + reopen panel (same session) → opens at last-set width; different session → same width.
- [ ] F-2.3 NFR restart persistence: close Fredo, relaunch, open session + panel → width equals last-set value (AppStore SQLite via settingsService; missing/corrupt value falls back to default without error).
- [ ] F-2.4 Resize does not change ReactFlow camera position/zoom or node layout (assert viewport before/after).

## R3 — Scrollable response area

- [ ] F-3.1 Long-response fixture: wheel and scrollbar-drag reveal the full response text end-to-end in the ChatNode response box (maxHeight 160).
- [ ] F-3.2 Wheel over the response box scrolls ONLY the box — ReactFlow camera position and zoom unchanged (assert `getViewport` before/after); `zoomOnScroll` still works on the rest of the canvas.
- [ ] F-3.3 No camera auto-center fires while scrolling a long response (auto-center only on new chat-node arrival, #2700 ST2).

## R4 — Chat node title shows agent + model

- [ ] F-4.1 Chat node title renders `{agent} · {model}` (e.g. `opencode · deepseek-v4-flash`) — literal `'Chat'` (useMissionMonitor.ts:65-67) never shown.
- [ ] F-4.2 Multi-model session: two sessions with different models → each node's title shows its own agent+model.
- [ ] F-4.3 No collateral change: subagent nodes still `Subagent · {name}`; tool/file labels unchanged; missing agent/model falls back deterministically (never "Chat").

## R5 — Real-time node updates while the agent works (LIVE — real opencode session required)

> Protocol (G-012): open Mission Monitor FIRST so its ECE contracts are registered, THEN start the agent session. Mock `fredo emit` events are structurally different (AGENTS.md) and are NOT valid evidence for R5.

- [ ] F-5.1 Chat node appears while the agent is still working (thinking/partial content mid-turn, no step completion, no refresh).
- [ ] F-5.2 Partial response text grows incrementally during streaming (`message.part.updated` deltas) without interaction; no duplicate text (concatenation idempotency + containment-first end-merge), no blanking on update deliveries, text survives `completeWhen` (#586).
- [ ] F-5.3 Thinking text, tool-call nodes, and a subagent node (real @-subagent dispatch) appear and update BEFORE the step ends; no spurious subagent nodes from internal `build`/`plan` tool sessions (#509/#523 filter).
- [ ] F-5.4 One node per chat turn — no duplicates from init/update/end re-processing, dual-transport, or composited child sessions; one `chat` edge per consecutive pair (verify edges via `rf__edge-*` test-id selectors — G-010).
- [ ] F-5.5 NFR: during a long multi-turn session the monitor stays responsive (pan/zoom/click fluid); console has no `Maximum update depth exceeded` (#523) and no webview freeze.
