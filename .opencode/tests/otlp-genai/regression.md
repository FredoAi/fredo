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

## Overlapping suites

- `opencode-plugin/regression.md` - emitter-side attribute keys consumed here
- `apps/ui` mission-monitor vitest suites - ECE consumers of the delivery payload

## Origin

Seeded at triage for #1499. Prior specs touching this domain; #601 (OTLP pipeline), #609 (canonical field injection), #633 (span hierarchy + gen_ai reading), #586 (event-state/completeWhen alignment).