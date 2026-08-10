# mission-monitor - Regression

"Must not change" baseline for the Mission Monitor delivery contract. Run on every
testing phase touching the ECE delivery path or `apps/ui/src/features/mission-monitor`.
Spec #2218 removes the standalone FredoEvent hop - the frontend contract shape is
load-bearing and must survive unchanged.

## Frontend contract invariants (must not change)

- [ ] R-1: Full mission-monitor vitest suite passes - `contract.test.ts`, `buildGraph.test.ts`, `useMissionMonitor.test.ts`, `counters.test.ts`, `layout.test.ts`, `persistence.test.ts`, `useSessionHistory.test.ts`; zero failures (QA-17)
- [ ] R-2: ECE 2-level payload nesting unchanged - `extractDeliveryPayload` inner `delivery.payload['payload']` path still resolves (`contract.ts:172-194`) (QA-23)
- [ ] R-3: Canonical field paths unchanged - `userMessage` / `agentReply` / `promptTokens` / `completionTokens` / `agent` / `model` single-path extraction (contract.test.ts canonical-path cases) (QA-23)
- [ ] R-4: Node lifecycle mapping unchanged - init creates nodes, update modifies, end completes (buildGraph init->update->end) (QA-23)
- [ ] R-5: Subagent payload fallbacks unchanged - `name|agent`, `output|response_text|agentReply` fallbacks in `makeSubagentNodePayload` still resolve OTLP-derived deliveries (`contract.ts:240-261`) - frontend is a non-goal of #2218 (QA-17)

## Delivery-pipeline invariants (must not change)

- [ ] R-6: ECE lifecycle regression - `cargo test` on `comm/contract/engine.rs`, `complete.rs`, `tests.rs` zero failures (Init/Update/Response ordering, timeout, completeWhen) (QA-21)
- [ ] R-7: #523 compositing - relationship-registry tests pass (parent-child re-key emits child-key `end` + parent-key `init`; 10k cap eviction at `engine.rs:739-745`) (QA-24)
- [ ] R-8: #586 completeWhen alignment - user-message Init never completes the buffer; `chat-node` completes only on `state === 'Response'` (QA-22)
- [ ] R-9: `chat-node` transport filter unchanged - `transports: ['otlp_grpc']`; hook events never create chat nodes (QA-16)

## Spec #2449 additions (re-open of #2218)

- [ ] R-10: Transport enum names stable - comm/event.rs:82-103 still maps OtlpGrpc => "otlp_grpc" (serde snake_case + as_str); chat-node filter transports:['otlp_grpc'] still matches live deliveries; no variant/value rename (NFR-4 / UI-UX Discussion point)
- [ ] R-11: Frontend contract matchers for all four subscription names unchanged - graph helpers still resolve chat-node, tool-use-lifecycle, subagent-lifecycle, custom-event delivery contractNames (R6 / renamed contract.ts -> lib/graph.ts)

## Spec #2688 additions (chat-chain rework + contract* cleanup)

- [ ] R-12: ECE engine behavior unchanged - `cargo test` on `comm/contract/*` zero failures; no changes to buffering, composite keys, completeWhen, timeout, Spec #523 relationship registry, or Spec #627 reset (ST1/ST6 non-goals)
- [ ] R-13: OTLP adapter correlation semantics unchanged - per-turn correlationId counters, session_to_parent span-link / session.parent_id detection, 10K caps, parent-prompt cache semantics (10K cap, oldest-first eviction) intact (ST6 non-goals)
- [ ] R-14: Plugin emission keys unchanged - the renamed plugin constants modules (telemetry-constants.ts, genai-conventions.ts) still emit identical span names, flat + gen_ai.* registry keys, log-event names, metric names, and ECE transport values (ST2 non-goal; genai-conventions suite R-1..R-14)
- [ ] R-15: subagent/tool/file node creation + edge types (parent/calls/reads/writes) unchanged (NFR-3)
- [ ] R-16: compaction display (COMPACTED_STYLES, compacted status) preserved; COMPACTED_STYLES moved to types.ts renders identically (NFR-4)
- [ ] R-17: incremental builder preserved - no full-graph rebuild per delivery, layout position cache + graph-signature recompute guard intact (NFR-1)
- [ ] R-18: Mission Monitor public API surface preserved - root feature index still exports the types, EMPTY_STATE_JOKES, isChatNodeDelivery, deliverySessionId, deliveryCorrelationId, extractDeliveryPayload, formatTokenCount under the renamed module (R6/ST7 non-goal)

## Overlapping suites

- `otlp-genai/regression.md` - adapter/ECE unit baseline the delivery contract depends on
- `opencode-plugin/regression.md` - emitter-side attributes that populate delivery payloads (genai-conventions suite)
- `apps/ui` mission-monitor vitest - the executable form of R-1..R-5

## Origin

Seeded at triage for #2218. Prior specs touching this domain: #318 (delivery-driven types),
#523 (parent-child compositing), #555 (compaction), #586 (completeWhen alignment),
#593 (contract deactivation), #627 (subagent output capture), #1499 (usage attrs).
