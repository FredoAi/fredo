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

## Spec #3197 additions (V2 port — unscripted probes)

> Levers: `FREDO_CAPTURE_EVENTS=<path>` (default OFF) on the external lever's environment, and the
> `scripts/run-external-session.ps1` opt-out/dead-endpoint switches. Non-AC probes; a confirmed
> finding promotes to `functional.md` with its origin note.

- [ ] E-11 (capture lever): with `FREDO_CAPTURE_EVENTS=.opencode/tmp/3197/e2e/<name>.jsonl`, one JSON
  line `{type, event}` per received event is appended and no other behaviour changes; with the var
  unset no file is created. (Owner: ST-1.)
- [ ] E-12 (interrupt key semantics): in a Terminal session, does `Esc` (`\u001b`) interrupt an
  in-flight turn while the TUI survives (the discriminator), or does only `Ctrl+C` (`\x03`) do it and
  exit? Record which key produced `session.execution.interrupted` — this is the lever F-35/F-37 rest on.
- [ ] E-13 (turn-root refresh): multi-turn session — does the `fredo.session` span stay one per turn
  root (refreshed prompt) rather than accumulating a span per text delta?
- [ ] E-14 (slow/dead export): with a dead endpoint, is the user-visible session latency unchanged
  (NFR-1's "never slow a user session")? Compare turn wall-clock against the healthy-endpoint run.
- [ ] E-15 (dropped `ended` event): kill a tool mid-flight — does the pending map stay bounded and
  does the sweeper close the orphan span instead of leaking it?