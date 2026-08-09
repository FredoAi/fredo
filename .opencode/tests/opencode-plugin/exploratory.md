# opencode-plugin - Exploratory

Unscripted probes for the plugin emitter domain. Run after functional + smoke; promote any confirmed finding to `functional.md` as a new `F-` row (keep the origin note).

## Probes

- [ ] E-1: Tool span shape when `part.state.input` is a deeply nested object - is `gen_ai.tool.call.arguments` still a well-formed JSON string without truncation?
- [ ] E-2: Tool span when `part.state.output` is large (multi-KB) - does `gen_ai.tool.call.result` survive the OTLP span size limits?
- [ ] E-3: Subagent session where `fredo.llm` is never created (non-streaming) - does the session span still carry `gen_ai.agent.name` and `gen_ai.conversation.id`?
- [ ] E-4: DeepSeek reasoning model - confirm `gen_ai.usage.reasoning.output_tokens` appears on the completed span while `agentReply` still contains the text part (not the thinking part)?
- [ ] E-5: Multi-turn cache reuse - run 3+ turns in one session; does `gen_ai.usage.cache_read.input_tokens` appear only after the first turn?
- [ ] E-6: `msg.finish` absent - is `gen_ai.response.finish_reasons` correctly omitted?
- [ ] E-7: Two rapid messages in the same session - do LLM spans and usage attrs stay per-message (no cross-contamination)?

## Spec #2680 additions

- [ ] E-8: Exception event on a tool-failure (message.ts:483 path) vs an LLM-API failure (message.ts:242 path) - does `exception.type`/`message` differ sensibly per failure mode?
- [ ] E-9: Subagent run - does the details event's `gen_ai.conversation.id` equal the subagent session (not the parent)?
- [ ] E-10: Multi-turn cache run - are usage attrs inside the details event present only on the completed turn (no premature emission)?