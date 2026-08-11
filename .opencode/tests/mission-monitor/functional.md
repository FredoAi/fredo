# mission-monitor - Functional

Durable test suite for the Mission Monitor delivery-contract consumer domain
(`apps/ui/src/features/mission-monitor`). Seeded at triage for #2218 (ECE delivers
`ContractDelivery` directly from the normalized OTLP projection; Mission Monitor
subscriptions + rendering unchanged). Cross-references: `otlp-genai` (Rust
receiver -> adapter -> ECE) and `opencode-plugin` (the emitter).

## Execution prerequisites

- dev;tauri running; `OPENCODE_ENABLE_TELEMETRY=1` for every `opencode run`
- Unique markers: `e2e-<guid>` for opencode runs, `qa-<guid>-*` for OTLP/HTTP JSON emitter batches
- Wait >=5s after each run for pipeline flush (SpanBuffer cadence, `telemetry/mod.rs:185-189`)
- `fredo emit` bypasses the OTLP receivers and MUST NOT be used for OTLP-path cases

## Manual UI execution steps (chat-node e2e — the tester drives the app, not just telemetry)

Most chat-node cases are MANUAL UI tests. Drive the running Fredo app through the webview
(`tauri_webview_*` tools — see the dev-environment skill E2E section), using telemetry only
to corroborate. For the 5-message chain (F-12..F-15):

1. Fresh slate: `powershell -File .opencode/scripts/clean-fredo-db.ps1 -Restart` (stops the app, wipes fredo.db, restarts).
2. Open **Run CLI** in the app; confirm the opencode terminal spawns (screenshot).
3. Send 5 consecutive prompts, each a unique marker: `say exactly: mm-<guid>-1` .. `mm-<guid>-5`.
4. After each response, screenshot the Mission Monitor graph (expect the newest chat node BELOW the previous one — top-to-bottom reading order; pre-#2694 this was newest-on-TOP, flipped by #2694 — see F-21).
5. After all 5: `tauri_webview_dom_snapshot` — count `.react-flow__node-agentNode` (must be exactly 5) and `.react-flow__edge` `e-chat-*` (must be exactly 4).
6. Click a chat node → screenshot the DetailPanel (INPUT / OUTPUT / THOUGHTS / MODEL / tokens / timing).
7. Corroborate with `telemetry-query` over `telemetry_spans` scoped to the test session id (5 chat spans, distinct correlationIds).

## Cases

- [ ] F-1: chat-node renders from a live run - `opencode run` (telemetry on); PASS if `.react-flow__node-agentNode` appears with userMessage + agentReply text and completes (AC4 / QA-13)
- [ ] F-2: tool + file nodes render - prompt reads a file (`read the file AGENTS.md`); PASS if `.react-flow__node-toolNode` and `.react-flow__node-fileNode` appear (AC4 / QA-14)
- [ ] F-3: subagent compositing renders - subagent dispatch prompt with marker text (Recipe 2); PASS if marker text found >=2x (agent + subagent nodes) and the subagent delivery carries `compositedChildSessionId` with `lifecycle: init` (AC4 + Spec #523 / QA-15)
- [ ] F-4: chat-node delivery shape unchanged - inspect one delivery: init -> update -> end; payload has `userMessage`, `agentReply`, `promptTokens`, `completionTokens`; inner payload at `delivery.payload['payload']` (AC3+AC4 / QA-12)
- [ ] F-5: user-message Init does not complete the contract - chat-node completes exactly on `state === 'Response'`; agentReply accumulates across update/end (NFR-1/#586 / QA-22)
- [ ] F-6: contract declaration is chat-only gRPC - `MissionMonitorFeature.tsx` `chat-node` declaration: transports `otlp_grpc`, eventTypes `['chat']` only (no `agent_session`), completeWhen `state === 'Response'` (Spec #2688 AC5 / R5)
- [ ] F-7: second-emitter spans reach the UI path - OTLP/HTTP JSON emitter batch (marker `qa-<guid>-emitter`) with `chat` + `tool_use.Bash` spans; PASS if the spans persist AND a delivery is produced for the emitter's chat span (AC2 / QA-08)
- [ ] F-8: Hook/IPC path untouched - `fredo emit` chat + tool_use events still render (baseline-vs-result DOM with unique session) (NFR-4 / QA-27)

## Spec #2449 additions (re-open of #2218)

- [ ] F-9: custom-event subscription unchanged - deliver a custom-event class OTLP delivery (e.g. permission.asked); PASS if `isCustomEventDelivery` resolves for the Hook path (renamed helpers under lib/graph.ts), no console error, and the eventContracts array remains chat-node-only (the #593-deactivated state is the baseline) (AC4)
- [ ] F-10: graph identical for the same session - replay the same e2e-<guid> session pre/post; PASS if `.react-flow__node-*` node set + edge set match the pre-spec snapshot (AC4)
- [ ] F-11: subscription declarations + matchers unchanged - `MissionMonitorFeature.tsx` eventContracts byte-identical except eventTypes `['chat']` (Spec #2688); graph helpers (isChatNodeDelivery / deliverySessionId / deliveryCorrelationId / extractDeliveryPayload) signatures intact under lib/graph.ts (AC4)

## Spec #2688 additions (chat-chain rework + contract* cleanup)

- [ ] F-12: 5 consecutive prompts in one session -> exactly 5 chat nodes - send `mm-<guid>-1..5` via Run CLI in ONE session; PASS if exactly 5 `.react-flow__node-agentNode` render, one per marker, each with its userMessage + agentReply, and exactly one session in the sidebar (zero duplicate / zero phantom nodes) (R1/AC1)
- [ ] F-13: vertical chain bottom-to-top with connecting edges - **SUPERSEDED by #2694 (direction flipped):** the OLD behavior asserted newest-on-top/oldest-at-bottom; #2694 flips to oldest-at-top/newest-at-bottom. Execute F-21 instead. Kept for the regression trail (R2/AC2 origin, #2688).
- [ ] F-14: auto-focus newest chat node (extended by #2694) - PASS if the canvas pans to center each newly added chat node after the initial load; #2694 adds: the pan is DEBOUNCED 300ms (a burst centers only the LAST node), preserves the user's zoom (pan-only, no zoom reset), and the `hadPriorNodes` initial-load guard still suppresses focus on the first batch — see F-22/F-23 (R3/AC3 + #2694 AC2)
- [ ] F-15: detailed view shows everything incl. thoughts - select a chat node; PASS if DetailPanel shows USER input, OUTPUT, THOUGHTS (when captured), MODEL (when known), token counts and timing; ChatNode shows token usage when data exists (R4/AC4). #2694 extends the ChatNode badge to three states (numbers / `— in / — out / — total` dashes / `hex tokens n/a`) with per-turn accuracy — see F-24..F-27
- [ ] F-16: agent_session produces no chat-node delivery - after a full session, PASS if telemetry_spans contains the run_agent session spans but the Mission Monitor graph / delivery stream contains only chat-span nodes (no empty/phantom nodes from agent_session) (R5/AC5)
- [ ] F-17: no contract_* files or identifiers remain - repo-wide search (files `contract_<N>.*` and identifiers starting `contract_`) returns zero hits outside the ECE module; .opencode/tests/* and docs/ARCHITECTURE.md references updated (R6/AC6)
- [ ] F-18: session DBs cleaned before e2e - PASS if `feature_mission-monitor_sessions`, `feature_mission-monitor_events` and `telemetry_spans` are empty before the run and hold exactly the expected session + 5 chat nodes after (R7/AC7)
- [ ] F-19: reload dedups restored + live deliveries - reload the app mid-session; PASS if the same 5 chat nodes render (no duplicates from persistence restore + live merge) (R1 edge case)
- [ ] F-20: subagent turn still renders under chat-only contract - dispatch a subagent; PASS if a SubagentNode still appears linked to its parent chat node (NFR-3 / subagent regression guard)

## Spec #2694 additions (reading-order flip, debounced auto-focus, per-turn token accuracy)

- [ ] F-21: vertical chain top-to-bottom (flip of F-13) - after >=3 prompts in one session, PASS if each new chat node sits vertically BELOW the previous one of that session and a `chat` chain edge connects each consecutive pair flowing downward (oldest at top, newest at bottom) (AC1)
- [ ] F-22: debounced auto-focus centers the last node of a burst - deliver 3 chat spans for the same session <300ms apart (emitter batch `qa-<guid>-burst`); PASS if exactly ONE pan occurs and the settled viewport centers the LAST node; no per-node camera jump (AC2 + NFR1)
- [ ] F-23: initial-load guard + zoom preservation - load a persisted 5-node session: exactly one initial fitView, no auto-focus storm; then zoom to a known level and add a node live: PASS if only a pan occurs and zoom is preserved (±0.05) (AC2)
- [ ] F-24: per-node token accuracy vs telemetry - >=5-turn run (incl. tool turns); PASS if EVERY node's badge `hex N in / M out / T total` equals that turn's own `gen_ai.usage.*` in `telemetry_spans` (per correlationId) and never the session running sum (AC3 + AC4)
- [ ] F-25: zero-token state - a turn whose span reports 0 input + 0 output; PASS if the badge renders `hex — in / — out / — total` (dashes), distinct from n/a (AC3)
- [ ] F-26: tokens n/a state - a turn with no per-turn source (Architect's sentinel, e.g. `promptTokens === -1` / `tokensUnavailable: true`); PASS if the badge renders `hex tokens n/a` (italic, muted, smaller) and never fabricates numbers (AC3 / out-of-scope disclosure)
- [ ] F-27: no Math.max ratchet - unit: end-delivery with per-turn tokens lower than an earlier update's value; PASS if the node's final promptTokens/completionTokens equal the per-turn (end) values, not the running max (AC3)
- [ ] F-28: multi-session ordering independence - two sessions' chains in one view; PASS if each session is independently oldest-at-top with uniform spacing and no cross-session y interleaving (AC1 edge)

## Evidence-on-pass

Append telemetry-query output, DOM snapshots, screenshots, and vitest/cargo run
results under each case; every live case's Evidence references `telemetry_spans`.
