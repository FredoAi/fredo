# otlp-genai - Functional

Durable test suite for the Rust OTLP surface domain; receiver (`infrastructure/otlp`), adapter (`infrastructure/comm/adapters/opencode.rs`), and storage (`telemetry_spans`). Seeded at triage for #1499 (complete OTel GenAI convention set consumed end-to-end). Cross-references; `opencode-plugin` (the emitter) and the adapter unit test suite (the "56-test suite").

## Execution prerequisites

- dev;tauri running; plugin telemetry enabled (`OPENCODE_ENABLE_TELEMETRY=1`)
- A live `opencode run` session whose LLM span completed with token counts
- Queries via `telemetry-query` (`telemetry-query.ps1 -Query "SELECT ... FROM telemetry_spans ..." -Format json`) with a unique `e2e-<guid>` session marker
- `fredo emit` bypasses the OTLP receivers and MUST NOT be used here

## Cases

- [ ] F-1: New usage attrs stored in `telemetry_spans` - after a live run; query `attributes_json` for the `fredo.llm` span of the test session; PASS if `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` appear as JSON keys when the payload provided those counts (AC-5). Edge; absent counts -> keys absent (passthrough of omission); row `transport` = `otlp_grpc`.
- [ ] F-2: Adapter maps reasoning usage into FredoEvent payload - `cargo test` case asserting `otlp_attrs_to_payload` maps `gen_ai.usage.reasoning.output_tokens` -> `info.turnReasoningTokens` (GA-5). PASS if the unit test exists and passes.
- [ ] F-3: Adapter maps cache usage into FredoEvent payload - `cargo test` cases asserting `gen_ai.usage.cache_read.input_tokens` -> `info.turnCacheReadTokens` and `gen_ai.usage.cache_creation.input_tokens` -> `info.turnCacheWriteTokens` (GA-5).
- [ ] F-4: Flat gen_ai attrs preserved in payload - `cargo test` asserting the raw `gen_ai.*` keys stay in the payload after mapping (GA-5) - i.e. the new mapping adds fields without dropping originals.
- [ ] F-5: Existing input/output mapping unchanged - `gen_ai.usage.input_tokens` -> `info.turnInputTokens` and `gen_ai.usage.output_tokens` -> `info.turnOutputTokens` still hold (`opencode.rs:1359-1367`).
- [ ] F-6: No empty-scalar injection - absent usage attrs produce no reasoning/cache field in the payload (`normalize_agent_payload_does_not_insert_empty_scalars` pattern); verified via a `cargo test` with empty attrs.
- [ ] F-7: String-encoded integers parsed - a `cargo test` feeding `gen_ai.usage.*` as strings still yields numeric payload fields (`value_as_i64` path).
- [ ] F-8: telemetry-query verifies the new attrs end-to-end - the tester-issue query (`SELECT span_name, attributes_json FROM telemetry_spans WHERE session_id = <e2e-session>`) returns the new usage keys for a real run (AC-5 storage leg).

## Spec #2218 additions (ingestion separation + provider-agnostic adapter)

- [ ] F-9: Raw spans persist on receipt - live opencode run; `SELECT COUNT(*), COUNT(DISTINCT span_id) FROM telemetry_spans WHERE session_id LIKE 'e2e-<guid>%'` == spans exported by the plugin (no dropped spans; AC1 / QA-01)
- [ ] F-10: Tool spans land in telemetry_spans - `SELECT DISTINCT span_name FROM telemetry_spans WHERE session_id LIKE 'e2e-<guid>%'` includes tool spans (the #1499 AC3 regression; AC5 / QA-18)
- [ ] F-11: Metrics + logs persist on receipt - `telemetry_metrics` (session.count/token.usage/cost.usage/tool.duration) and `telemetry_logs` (session.created/api_request/...) rows for the run (AC1 / QA-03/04)
- [ ] F-12: Non-completing spans persist - OTLP/HTTP JSON batch with one open span; every span row present on receipt (AC1 / QA-06)
- [ ] F-13: Provider-agnostic adapter accepts generic span names - OTLP/HTTP JSON batch with non-`fredo.*` names + `gen_ai.operation.name` attrs; rows persist with emitter identity, no `fredo.*` rewrite, provider != open-code (AC2 / QA-07)
- [ ] F-14: HTTP-leg metrics/logs persist - OTLP/HTTP JSON metrics + logs POSTs land in `telemetry_metrics` / `telemetry_logs` (AC1 / QA-05; currently dropped at `http.rs:129-145`)
- [ ] F-15: No standalone FredoEvent in the delivery path - `git grep FredoEvent` in `infrastructure/otlp/` + generic adapter returns nothing; new Rust unit test proves normalized-projection -> `Vec<SubscriptionDelivery>` (AC3 / QA-09..11)

## Evidence-on-pass

Append the telemetry-query output (span_name + matching attribute keys) or the `cargo test` case name + pass line under each case.