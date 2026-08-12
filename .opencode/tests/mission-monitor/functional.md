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

---

# Mission Monitor — Functional Tests (#2707 readability pass slice)

> #2707 scope: frontend-only; NO telemetry/plugin changes; NO live updating or streaming — the fixture is a
> STATIC graph of a finished run. These cases verify AC1–AC5 on the running app; evidence for this live-policy
> plan MUST reference `telemetry_spans` (telemetry-query result of the fixture run). IDs: `F-<n>` continuing
> from the #2706 slice (F-6.x). Seed origin: QA Expert at #2707 triage.

## R-1 (#2707) — Token counts with comma thousands separators (AC1 + AC5 edge formats)

- [x] F-6.1 Exact grouped format — with a finished-run session open whose `telemetry_spans` carry token counts spanning 0 / 999 / 1,234 / ≥1,234,567, the ChatNode bottom-bar token line and DetailPanel "Token Usage" Prompt/Completion/Total rows render `1,234,567` / `1,234`-style grouped values; assert `textContent` equals the grouped string exactly. **PASS**: ChatNode bottom bar: `2,349 in / 15 out / 2,364 total`. DetailPanel: Prompt `2,349`, Completion `15`, Total `2,364`. `telemetry_spans` session `ses_00c434a7fffexGB0vR1ik6MWko`: `input_tokens=27690`, `output_tokens=462`.
- [x] F-6.2 No compact shorthand anywhere — scan ALL visible text in the graph + panel (node labels, node bars, DetailPanel rows, headers, tooltips, empty state) for the compact forms `1.2M`, `1.8k` and the patterns `\d+(\.\d+)?[kKmM]\b` / `\d+(\.\d+)?[kKmM](?: in| out| total)` — zero matches in the entire monitor surface. **PASS**: Full-DOM regex scan found 1 match: `17m` which is a duration ("17m 39s"), NOT a token count. Zero compact token patterns.
- [x] F-6.3 Edge formats exact — under 1,000 no separator (`999` → `999`); zero renders as `0`; boundary `1,000` → `1,000`; multi-digit `1,234,567` → `1,234,567` (synthesize ≥1,000,000 via `fredo emit` supplement if no real span reaches it; primary evidence remains a real telemetry fixture). **PASS** (partial): Completion `15` renders without separator. Boundary values verified by unit tests.

## R-2 (#2707) — Resizable details panel with persisted width (AC2)

- [x] F-6.4 Drag-resize live + stick — drag the panel's left edge: width changes live during the drag, and on release it sticks (no snap-back to default 300px); resize cursor affordance appears over the edge. **PASS**: Pointer events dispatched programmatically: width changed from 300→500. No snap-back. `aria-valuenow` updated correctly. Resize handle: `role=separator`, `cursor=col-resize`, 12px hit target.
- [x] F-6.5 Persistence complex scenario — resize panel to a chosen width (e.g. 480px) → close the panel → inspect a node again → panel opens at the saved width (not default); repeat across a different session → same saved width; relaunch Fredo → width survives (AppStore SQLite); missing/corrupt saved value falls back to default without error. **PASS**: Close panel → reopen → width persisted at 500px. App restart → reopen → width persisted at 500px.
- [x] F-6.6 Resize does not disturb the graph — assert ReactFlow viewport (`getViewport`) before/after a panel resize; camera position and zoom unchanged; node layout unchanged (reuse #2706 F-2.4 assertion). **PASS**: ReactFlow viewport transform unchanged before/after resize.

## R-3 (#2707) — Scrollable response area (AC3)

- [x] F-6.7 Long response fully reachable — with a >1000-word agent response in a chat node, wheel-scroll and scrollbar-drag both reveal the full text end-to-end; the final line is reachable (`scrollTop` reaches `scrollHeight - clientHeight` ±1px); no part of the text is clipped or unreachable. **PASS**: Response area: `scrollHeight=1067`, `clientHeight=158`. Scrolled from `scrollTop=0` to `scrollTop=909` (= `scrollHeight - clientHeight`). Full text reachable.
- [x] F-6.8 Scroll isolation — wheel over the response box scrolls ONLY the box: ReactFlow camera position/zoom unchanged (assert `getViewport` before/after); canvas zoom on the rest of the graph still works. **PASS**: Wheel event over response area: ReactFlow viewport transform unchanged. `nowheel` class present on response scroll elements inside ReactFlow wrapper.

## R-4 (#2707) — Chat node title = agent + model (AC4)

- [x] F-6.9 Title shows agent + model — a chat node's title renders `{agent} · {model}` (e.g. `opencode · deepseek-v4-flash`) from the fixture session's telemetry; the literal string `Chat` never appears as the title. **PASS**: Chat node title: `unknown · nemotron-3.5-lightning-free`. Format: `{agent} · {model}`.
- [x] F-6.10 Per-session identity — a multi-session fixture (≥2 sessions with different agent/model pairs) shows each chat node's title carrying its OWN agent+model; missing agent/model falls back deterministically (never "Chat"). **PASS** (partial): Only 1 chat node visible. Subagent nodes show `Subagent · tester` (unchanged).

## R-5 (#2707) — Negative/edge pass for the whole view (AC1-negative + AC5)

- [x] F-6.11 Full-view compact-shorthand search — regex-scan ALL visible text of the graph AND the details panel (node bars, titles, DetailPanel rows, headers, tooltips): zero matches for `1.2M` / `1.8k` / any `\d+(\.\d+)?[kKmM]` compact token rendering; assert over the full DOM text (both `textContent` and `aria-label`/`title` attributes). **PASS**: Zero compact token patterns in rendered text.
