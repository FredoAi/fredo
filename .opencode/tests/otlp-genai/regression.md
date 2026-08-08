# otlp-genai - Regression

"Must not change" baseline for the Rust OTLP surface. Run on every testing phase touching the OTLP receiver / adapter / `telemetry_spans`. Spec #1499 is additive (new usage fields surfaced) - existing extraction paths, event mapping, and ECE delivery behavior below are load-bearing.

## Adapter unit suite

- [ ] R-1: The adapter unit test suite (the "56-test suite" baseline) passes - `cargo test` on `opencode.rs` + `contract_633.rs` + `contract_633_ac6c.rs` with zero failures

## Extraction priorities (must not change)

- [ ] R-2: `gen_ai.usage.*` preferred over flat `input_tokens`/`output_tokens` in payload extraction (`opencode.rs:1359-1367`) - verified by existing tests `gen_ai_usage_tokens_preferred_over_flat_tokens`, `ac_2_otlp_attrs_to_payload_*`
- [ ] R-3: `gen_ai.prompt` preferred over `prompt` over `instruction` for user-message/instruction extraction (`contract_633.rs` REQ-7 extractors)
- [ ] R-4: `gen_ai.response.body` preferred over `response_text` for agent-reply extraction (`opencode.rs:1309-1312, 1372`)

## Canonical payload fields (must still be injected)

- [ ] R-5: `userMessage`, `agentReply`, `promptTokens`, `completionTokens`, `model`, `instruction`, `is_subagent`, `agent.type` still injected by `otlp_attrs_to_payload` (existing tests `req_609_otlp_attrs_to_payload_includes_canonical_fields` etc.)

## Event routing + ECE invariants

- [ ] R-6: `gen_ai.operation.name` routing unchanged - `fredo.session` -> AgentSession/Init only (REQ-609); `fredo.llm` -> Chat; `fredo.tool.*` -> ToolUse (`opencode.rs:2117-2131`)
- [ ] R-7: Session spans emit exactly one Init (no premature Response) - existing REQ-609 tests still pass
- [ ] R-8: ECE delivery lifecycle unchanged - Init/Update/Response ordering and correlationId/turn logic intact (no spec-1499 change to those paths)
- [ ] R-9: Subagent relationship compositing unchanged - `session_to_parent` / relationship metadata paths untouched

## Storage

- [ ] R-10: `telemetry_spans` schema unchanged - no new columns; new attributes ride the existing `attributes_json` payload passthrough (`telemetry/mod.rs:299-312`)

## Spec #2218 additions (must not change)

- [ ] R-11: Tool-span identity + status preserved - tool span row has tool-name key (`gen_ai.tool.name`/`tool_name`) and `status_code` OK/ERROR (AC5 / QA-19)
- [ ] R-12: Extraction priorities unchanged - `gen_ai.usage.*` preferred over flat tokens; `gen_ai.prompt` over `prompt`; `gen_ai.response.body` over `response_text` (adapter unit tests still green) (QA-26)
- [ ] R-13: EventState/completeWhen alignment unchanged - `Response` iff `endTimeUnixNano` (`opencode.rs:1490-1497`), session spans `Init`; `chat-node` completes only on `state === 'Response'` (#586) (QA-21/22)
- [ ] R-14: ECE compositing unchanged - relationship registry + re-key end/init emissions (Spec #523) unit tests green (QA-24)
- [ ] R-15: `telemetry_spans` schema unchanged - no new columns; raw attributes ride `attributes_json` (`span_store.rs:10-29`) (QA-26)
- [ ] R-16: Full adapter/ECE unit suite passes - `cargo test` on `opencode.rs` + `contract_633.rs` + `contract_633_ac6c.rs` + `contract/tests.rs` + `contract/complete.rs` + `contract/engine.rs`, zero failures (the "56/58-test suite" — count drifts; criterion is zero failures) (QA-26)

## Spec #2449 additions (re-open of #2218)

- [ ] R-17: Transport enum variant names + as_str() values stable - event.rs:82-103 (hook, otlp_grpc, otlp_http, web_socket, http_post, internal); ECE transport filtering depends on these (NFR-4)

## Overlapping suites

- `opencode-plugin/regression.md` - emitter-side attribute keys consumed here
- `apps/ui` mission-monitor vitest suites - ECE consumers of the delivery payload

## Origin

Seeded at triage for #1499. Prior specs touching this domain; #601 (OTLP pipeline), #609 (canonical field injection), #633 (span hierarchy + gen_ai reading), #586 (event-state/completeWhen alignment). Extended for #2218 (ingestion separation + provider-agnostic adapter).