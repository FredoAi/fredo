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
- [ ] F-6: contract declarations unchanged - `MissionMonitorFeature.tsx` `chat-node` declaration identical (transports `otlp_grpc`, eventTypes `chat`+`agent_session`, completeWhen `state === 'Response'`) (AC4 / QA-16)
- [ ] F-7: second-emitter spans reach the UI path - OTLP/HTTP JSON emitter batch (marker `qa-<guid>-emitter`) with `chat` + `tool_use.Bash` spans; PASS if the spans persist AND a delivery is produced for the emitter's chat span (AC2 / QA-08)
- [ ] F-8: Hook/IPC path untouched - `fredo emit` chat + tool_use events still render (baseline-vs-result DOM with unique session) (NFR-4 / QA-27)

## Evidence-on-pass

Append telemetry-query output, DOM snapshots, screenshots, and vitest/cargo run
results under each case; every live case's Evidence references `telemetry_spans`.
