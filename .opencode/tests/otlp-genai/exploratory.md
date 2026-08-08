# otlp-genai - Exploratory

Unscripted probes for the OTLP surface domain. Run after functional + smoke; promote any confirmed finding to `functional.md` as a new `F-` row (keep the origin note).

## Probes

- [ ] E-1: Span with usage attrs but NO `gen_ai.operation.name` - does `normalize_op_name` still classify it via span name, and do the usage fields still surface?
- [ ] E-2: Span whose `gen_ai.usage.reasoning.output_tokens` is a string (not int) - parsed correctly?
- [ ] E-3: Init vs Response payloads for a single LLM span - usage fields present on the Response event only (no premature completeWhen)?
- [ ] E-4: Very large `gen_ai.tool.call.arguments` JSON string through the receiver - no truncation or deserialization error?
- [ ] E-5: Dual-transport run (Hook + OTLP both active) - new attrs arrive only via `otlp_grpc` spans; no cross-transport leakage?
- [ ] E-6: Subagent span with late relationship metadata - usage fields still mapped after compositing re-key?
- [ ] E-7: telemetry-query guardrails - a DDL/DML query is rejected by the wrapper (read-only enforcement)?
- [ ] E-8: Standard OTLP/JSON envelope (`resourceSpans` key) via HTTP receiver - accepted and classified (confirms the AC2 test payload shape)
- [ ] E-9: OTLP/HTTP JSON batch of 200 spans in one export - all persist, count == 200 (zero-loss under load; QA-25)
- [ ] E-10: Span with no session/correlation identity - persists with raw identity on receipt (today `SpanCollector` skips, `telemetry/mod.rs:259-262`)
- [ ] E-11: String-encoded integer attrs in an OTLP/HTTP JSON batch - parsed without loss

## Spec #2449 additions (re-open of #2218)

- [ ] E-12: Concurrent gRPC + HTTP exports with overlapping spanIds - no crash, idempotent persistence (store-write race)
- [ ] E-13: Generic emitter with standard resourceSpans envelope + service.name != fredo-opencode-plugin - classified, persisted, delivered
- [ ] E-14: Ingestion latency - span row visible via telemetry-query within one flush cadence (~5s) of export completing