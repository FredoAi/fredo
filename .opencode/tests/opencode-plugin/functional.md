# opencode-plugin - Functional

Durable test suite for the Fredo OpenCode plugin emitter domain (`apps/opencode-plugin`). Seeded at triage for #1499 (complete OTel GenAI convention set). Span kinds covered; `fredo.llm` (LLM/chat), `fredo.tool.*` (tool), `fredo.session` (session/agent). Cross-references; `otlp-genai` (Rust OTLP receiver -> adapter -> `telemetry_spans`) and the Rust adapter unit suite (the "56-test suite").

## Execution prerequisites

- dev;tauri running (OTLP gRPC receiver on 127.0.0.1:4317)
- `opencode` binary + API credentials configured; Fredo plugin installed for opencode
- `OPENCODE_ENABLE_TELEMETRY=1` set for every `opencode run` (plugin init gate, `config.ts:72`)
- `fredo emit` bypasses the OTLP receivers (IPC -> EventBus) and MUST NOT be used here
- Verification via `telemetry-query` (`telemetry-query.ps1`) with a unique `e2e-<guid>` session marker

## Cases

- [ ] F-1: LLM span carries the system/provider identity - run `opencode run` one chat turn with telemetry on; query the `fredo.llm` span for the session; PASS if `attributes_json` contains `gen_ai.provider.name` = the real providerID (e.g. `anthropic`, `openai`, `deepseek`) per GA-1. Edge; missing providerID -> attribute omitted.
- [ ] F-2: LLM span carries `gen_ai.operation.name=chat` - same span; PASS if present. Edge; non-streaming messages (no `fredo.llm` span created); subagent LLM spans.
- [ ] F-3: LLM span carries request identity - PASS if `gen_ai.request.model` = modelID and `gen_ai.conversation.id` = sessionID when available (GA-1).
- [ ] F-4: Completed LLM span carries the full usage set - run a second turn to trigger cache; PASS if `attributes_json` contains `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` when the payload provides the counts (GA-2). Edge; zero/absent counts -> attribute omitted; string-encoded integers parsed; counts only on the completed span.
- [ ] F-5: Completed LLM span carries response identity - PASS if `gen_ai.response.model` = modelID and `gen_ai.response.finish_reasons` = the finish value array when present (GA-2).
- [ ] F-6: Tool span carries tool identity - run a prompt that executes a tool (e.g. `read the file AGENTS.md`); PASS if the `fredo.tool.<name>` span has `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name` = tool name, and `gen_ai.tool.call.id` = callID (GA-3). Edge; tool without callID.
- [ ] F-7: Tool span carries call arguments - PASS if `gen_ai.tool.call.arguments` = JSON string of the tool input when input is present (GA-3). Assert the string form (OTel JS SDK has no object AttributeValue).
- [ ] F-8: Tool span carries call result on success - PASS if `gen_ai.tool.call.result` = JSON string of the output on a completed tool (GA-3). Edge; failed tool -> no result attribute.
- [ ] F-9: Tool span carries the agent name - PASS if `gen_ai.agent.name` is set when the agent is known (GA-3). Edge; unknown/empty agent.
- [ ] F-10; Session span carries the stable op name - PASS if the `fredo.session` span has `gen_ai.operation.name=run_agent` (documented opencode-specific value) and `gen_ai.conversation.id` = sessionID (GA-4). Edge; primary vs subagent session.
- [ ] F-11; Session span carries the agent name once resolved - run an @-subagent dispatch; PASS if `gen_ai.agent.name` appears on the subagent session span (GA-4). Edge; agent resolved only at session idle / chat.message.
- [ ] F-12; Legacy attrs preserved alongside new ones - PASS if `gen_ai.prompt`, `gen_ai.response.body`, `prompt`, `response_text`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `tool_name`, `model`, `provider` still appear on the relevant spans (NFR-1).
- [ ] F-13; Plugin still builds and typechecks - `bun build` and `tsc --noEmit` in `apps/opencode-plugin` exit 0.