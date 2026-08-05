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