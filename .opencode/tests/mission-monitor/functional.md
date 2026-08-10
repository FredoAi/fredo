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
- [ ] F-13: vertical chain bottom-to-top with connecting edges - after >=3 prompts, PASS if each new chat node sits vertically ABOVE the previous one of that session and a `chat` chain edge connects each consecutive pair (oldest at bottom) (R2/AC2)
- [ ] F-14: auto-focus newest chat node - PASS if the canvas pans to center each newly added chat node after the initial load (R3/AC3)
- [ ] F-15: detailed view shows everything incl. thoughts - select a chat node; PASS if DetailPanel shows USER input, OUTPUT, THOUGHTS (when captured), MODEL (when known), token counts and timing; ChatNode shows token usage when data exists (R4/AC4)
- [ ] F-16: agent_session produces no chat-node delivery - after a full session, PASS if telemetry_spans contains the run_agent session spans but the Mission Monitor graph / delivery stream contains only chat-span nodes (no empty/phantom nodes from agent_session) (R5/AC5)
- [ ] F-17: no contract_* files or identifiers remain - repo-wide search (files `contract_<N>.*` and identifiers starting `contract_`) returns zero hits outside the ECE module; .opencode/tests/* and docs/ARCHITECTURE.md references updated (R6/AC6)
- [ ] F-18: session DBs cleaned before e2e - PASS if `feature_mission-monitor_sessions`, `feature_mission-monitor_events` and `telemetry_spans` are empty before the run and hold exactly the expected session + 5 chat nodes after (R7/AC7)
- [ ] F-19: reload dedups restored + live deliveries - reload the app mid-session; PASS if the same 5 chat nodes render (no duplicates from persistence restore + live merge) (R1 edge case)
- [ ] F-20: subagent turn still renders under chat-only contract - dispatch a subagent; PASS if a SubagentNode still appears linked to its parent chat node (NFR-3 / subagent regression guard)

## Evidence-on-pass

Append telemetry-query output, DOM snapshots, screenshots, and vitest/cargo run
results under each case; every live case's Evidence references `telemetry_spans`.
