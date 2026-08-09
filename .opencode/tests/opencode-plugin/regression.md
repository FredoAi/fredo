# opencode-plugin - Regression

"Must not change" baseline for the plugin emitter domain. Run on every testing phase that touches `apps/opencode-plugin`. The spec #1499 change is additive (new `gen_ai.*` keys alongside existing flat keys) - anything below regressing is a FAIL.

## Emitted attribute baseline (must remain)

- [ ] R-1: Existing gen_ai keys unchanged - `gen_ai.operation.name`, `gen_ai.prompt`, `gen_ai.response.body`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` still emitted on the same span kinds as before #1499 (`contract_633.ts` constants unchanged)
- [ ] R-2: Flat span attribute keys unchanged - `session.id`, `agent.type`, `is_subagent`, `session.parent_id`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `model`, `provider`, `duration_ms`, `success`, `tool_name`, `tool.success`, `tool.error`, `tool.result_size_bytes`, `total_tokens`, `total_cost_usd`, `total_messages` still emitted (`contract_601.ts:27-54`)
- [ ] R-3: `gen_ai.operation.name` values stable - `chat` / `execute_tool` / `run_agent` exactly (`contract_633.ts:15-21`); `validateGenAiOpName` still accepts them (NFR-2)
- [ ] R-4: Span names stable - `fredo.session`, `fredo.llm`, `fredo.tool.<name>` (`contract_601.ts:16-22`)
- [ ] R-5: Span link attributes unchanged - `parent.session_id` and `relationship.type=parent-child` on subagent session span links (`contract_633.ts:43-49`)
- [ ] R-6: Log events unchanged - `session.created`, `session.idle`, `session.error`, `api_request`, `api_error`, `tool_result`, `user_prompt` still emitted with their attribute sets (`contract_601.ts:92-101`)
- [ ] R-7: Metric names unchanged - `session.count`, `token.usage`, `cost.usage`, `tool.duration` (`contract_601.ts:105-108`)
- [ ] R-8: Resource identity unchanged - `service.name=fredo-opencode-plugin` (`otel.ts:52`)

## Build/type gates

- [ ] R-9: Plugin builds - `bun build` in `apps/opencode-plugin` exits 0
- [ ] R-10: Plugin typechecks - `tsc --noEmit` in `apps/opencode-plugin` exits 0

## Spec #2680 additions (must not change)

- [ ] R-11: Legacy keys removed from NEW emission but historical rows untouched - old spans keep `gen_ai.prompt`/`gen_ai.response.body`; no assertion runs against pre-existing rows
- [ ] R-12: Flat span attribute keys unchanged - `prompt`, `response_text`, `input_tokens`, `output_tokens`, `session.id`, `agent.type`, etc. still emitted alongside the renamed keys (`contract_601.ts:27-54`)
- [ ] R-13: Existing metric names unchanged - `session.count`, `token.usage`, `cost.usage`, `tool.duration`, `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, `gen_ai.execute_tool.duration`, `gen_ai.invoke_agent.duration` still emitted (`otel.ts`)
- [ ] R-14: Log events unchanged - `session.created`, `session.idle`, `session.error`, `api_request`, `api_error`, `tool_result`, `user_prompt` still emitted with their attribute sets (`contract_601.ts:92-101`); only the two gen_ai event names move to span events
- [ ] R-15: Plugin builds + typechecks - `bun build` and `tsc --noEmit` exit 0

## Overlapping suites

- `otlp-genai/regression.md` - Rust adapter extraction paths that consume these attributes
- `apps/ui` mission-monitor vitest suites - ECE consumers of `turnInputTokens`/`turnOutputTokens` etc.

## Origin

Seeded at triage for #1499. Prior specs touching this domain; #601 (OTLP plugin rewrite), #633 (span hierarchy + partial gen_ai set), #627 (subagent output capture).