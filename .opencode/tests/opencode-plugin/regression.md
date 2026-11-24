# opencode-plugin - Regression

"Must not change" baseline for the plugin emitter domain. Run on every testing phase that touches `apps/opencode-plugin`. The spec #1499 change is additive (new `gen_ai.*` keys alongside existing flat keys) - anything below regressing is a FAIL.

## Emitted attribute baseline (must remain)

- [ ] R-1: Existing gen_ai keys unchanged - `gen_ai.operation.name`, `gen_ai.prompt`, `gen_ai.response.body`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` still emitted on the same span kinds as before #1499 (`genai-conventions.ts` constants unchanged)
- [ ] R-2: Flat span attribute keys unchanged - `session.id`, `agent.type`, `is_subagent`, `session.parent_id`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `model`, `provider`, `duration_ms`, `success`, `tool_name`, `tool.success`, `tool.error`, `tool.result_size_bytes`, `total_tokens`, `total_cost_usd`, `total_messages` still emitted (`telemetry-constants.ts:27-54`)
- [ ] R-3: `gen_ai.operation.name` values stable - `chat` / `execute_tool` / `run_agent` exactly (`genai-conventions.ts:15-21`); `validateGenAiOpName` still accepts them (NFR-2)
- [ ] R-4: Span names stable - `fredo.session`, `fredo.llm`, `fredo.tool.<name>` (`telemetry-constants.ts:16-22`)
- [ ] R-5: Span link attributes unchanged - `parent.session_id` and `relationship.type=parent-child` on subagent session span links (`genai-conventions.ts:43-49`)
- [ ] R-6: Log events unchanged - `session.created`, `session.idle`, `session.error`, `api_request`, `api_error`, `tool_result`, `user_prompt` still emitted with their attribute sets (`telemetry-constants.ts:92-101`)
- [ ] R-7: Metric names unchanged - `session.count`, `token.usage`, `cost.usage`, `tool.duration` (`telemetry-constants.ts:105-108`)
- [ ] R-8: Resource identity unchanged - `service.name=fredo-opencode-plugin` (`otel.ts:52`)

## Build/type gates

- [ ] R-9: Plugin builds - `bun build` in `apps/opencode-plugin` exits 0
- [ ] R-10: Plugin typechecks - `tsc --noEmit` in `apps/opencode-plugin` exits 0

## Spec #2680 additions (must not change)

- [ ] R-11: Legacy keys removed from NEW emission but historical rows untouched - old spans keep `gen_ai.prompt`/`gen_ai.response.body`; no assertion runs against pre-existing rows
- [ ] R-12: Flat span attribute keys unchanged - `prompt`, `response_text`, `input_tokens`, `output_tokens`, `session.id`, `agent.type`, etc. still emitted alongside the renamed keys (`telemetry-constants.ts:27-54`)
- [ ] R-13: Existing metric names unchanged - `session.count`, `token.usage`, `cost.usage`, `tool.duration`, `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, `gen_ai.execute_tool.duration`, `gen_ai.invoke_agent.duration` still emitted (`otel.ts`)
- [ ] R-14: Log events unchanged - `session.created`, `session.idle`, `session.error`, `api_request`, `api_error`, `tool_result`, `user_prompt` still emitted with their attribute sets (`telemetry-constants.ts:92-101`); only the two gen_ai event names move to span events
- [ ] R-15: Plugin builds + typechecks - `bun build` and `tsc --noEmit` exit 0

## Spec #3197 additions (OpenCode 2 / V2 port — nothing below may change)

- [ ] R-16: `apps/tauri/src-tauri/src/infrastructure/rtdb/attrs.rs` is **byte-identical to `main`** —
  `scripts/verify-contract-immutable.ps1` prints `PATH=attrs.rs STATUS=IDENTICAL`.
- [ ] R-17: `apps/tauri/src-tauri/src/infrastructure/rtdb/ingest.rs` is **byte-identical to `main`** —
  same script prints `PATH=ingest.rs STATUS=IDENTICAL` and `CONTRACT-DIFF-EMPTY: true`.
- [ ] R-18: Mission Monitor is untouched and renders the ported rows unchanged — no `apps/ui/` file
  appears in the spec diff, and the F-31 render of a live V2 session succeeds with the panel's
  existing list/chat/tool/token surfaces.
- [ ] R-19: the classifier's mapping is unchanged — operation-name-driven classification
  (`run_agent`/`chat`/`execute_tool`), session identity precedence, parent precedence
  (link → `session.parent_id`), payload projection and the drop rule for unclassifiable spans.
- [ ] R-20: the emitted contract vocabulary is unchanged — V1 key set (`fredo.session` / `fredo.llm` /
  `fredo.tool.<name>` span names; `gen_ai.operation.name`/`provider.name`/`request.model`/
  `input.messages`/`output.messages`/`usage.*`/`tool.*`; the flat Fredo-native attributes; the nine
  log bodies incl. `commit` and `tool_decision`; the metric names; `service.name=fredo-opencode-plugin`).
  The earlier rows R-1..R-15 encode this baseline — their `file:line` citations are V1-era and are
  historical; assert the KEY VOCABULARY, not the line numbers.
- [ ] R-21: the build surface is unchanged — one `bun build src/index.ts --outdir dist --target bun`
  script, run as `pnpm --filter @fredo/fredo-opencode-plugin build`, producing
  `apps/opencode-plugin/dist/index.js` as the single artifact.

## Overlapping suites

- `otlp-genai/regression.md` - Rust adapter extraction paths that consume these attributes
- `mission-monitor/regression.md` - the row consumers (R-21 classifier mapping, R-45/R-53 provider
  attribution + render) that this port must leave unchanged
- `apps/ui` mission-monitor vitest suites - ECE consumers of `turnInputTokens`/`turnOutputTokens` etc.

## Origin

Seeded at triage for #1499. Prior specs touching this domain; #601 (OTLP plugin rewrite), #633 (span hierarchy + partial gen_ai set), #627 (subagent output capture).