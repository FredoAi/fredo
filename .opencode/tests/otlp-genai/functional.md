# otlp-genai - Functional

Durable test suite for the Rust OTLP surface domain. Spec #2680 additions tested 2026-08-10.

## Spec #2680 additions (renamed-key adapter mapping + span-event persistence)

- [x] F-19: Adapter maps renamed keys to canonical fields **PASS** (developer cargo test)
- [x] F-20: Renamed keys persist live **PASS** - e2e session shows gen_ai.input.messages and gen_ai.output.messages on spans
- [x] F-21: events_json populated **PASS** - ERROR span has non-empty events_json with exception event
- [x] F-22: events_json populated for completed ops **PASS** - OK fredo.llm span has details event
- [x] F-23: events_json format stable **PASS** - OTLP proto event array with name + attributes
- [x] F-24: Four new metrics persist **PASS** - telemetry_metrics histogram rows for all four names
- [x] F-25: Out-of-scope metrics not persisted **PASS** - gen_ai.server/invoke_workflow/evaluation = 0
- [x] F-26: Instruction injection uses renamed key **PASS** (developer cargo test)
- [x] F-27: Schema unchanged **PASS** - PRAGMA table_info shows 16 columns, no new columns
