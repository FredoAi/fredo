# GitHub Copilot CLI Capture — Exploratory Probes (Spec #2933)

> Unscripted probes for the Tester. Each is a `- [ ]` prompt; a confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note). Run after functional + smoke.

## Content / extraction shapes

- [x] E-1: With content disabled, is the degradation marker present on EVERY row class (chat/tool/session), or only chat — and is it the same marker the plan documents?
  - **PASS (deterministic).** All three classes carry the marker: `chat_rows` (`in_msgs=0/out_msgs=0`), `tool_use_rows` (`tool_args=0/tool_res=0`), and `agent_session_rows` (`raw_json` free of all four keys) for `e2e-copiloto2933off`. Real content-off drive `76cc4361-…` agrees.
- [x] E-2: A tool call whose arguments are hidden but whose result IS present (or vice versa) — do the tool row's fields degrade independently, or does one masked field blank the other?
  - **PASS (deterministic).** Partial fixture `e2e-copilotpartial2933`: `view` row → `tool_input_json` present + `tool_output_json` NULL; `grep` row → `tool_input_json` NULL + `tool_output_json` present. Fields degrade **independently** (no cross-blanking). The chat row also carried `user_message` with `agent_reply` NULL (output channel independently absent).
- [x] E-3: A very long prompt / a multi-part message array — is the extracted `userMessage` truncated, empty, or the first text part only? Compare with the OpenCode extractor's behavior.
  - **PASS (recorded behaviour).** A two-part `gen_ai.input.messages` produced `user_message = "FIRSTPART_SHORT sentence.SECONDPART_LONG this is the long continuation segment …"` — **parts JOINED** (not truncated, not first-part-only). Same shared `attrs.rs` rule the OpenCode path uses.
- [x] E-4: A prompt that triggers multiple tool calls in one turn — are all tool rows produced, and do their correlation ids stay distinct (no collapse into one key)?
  - **PASS (deterministic).** Two `execute_tool` spans in one batch → two rows `…_3` (`view`) and `…_4` (`grep`), distinct correlation ids, both `tool_success = 1`, each with its own span-timing `duration_ms`.

## Identity / keying

- [x] E-5: Force a Copilot session-id pattern that looks like an OpenCode id (`ses_…`) — does any key collide, or does the provider + session namespace keep them separate?
  - **PASS (deterministic).** `--prefix ses_copilots2933` → rows `ses_copilots2933_{1,2,3}` all `provider = copilot_cli`; no collision with the real OpenCode session `ses_f358e9c58ffeCnb7iL44S7rR1s`, no provider flip.
- [ ] E-6: A Copilot session that also carries a `session.parent_id` (subagent/child) — does it composite under a parent, and does the compositing preserve `provider`?
  - **UNVERIFIED (named blocker).** Real Copilot 1.0.88 spans carry **no** parent attribution (the plan's documented limitation — no child→parent compositing for Copilot). Forcing one by injecting a synthetic `session.parent_id` onto a Copilot-shaped span would not model a real capture (G-088) and the plan explicitly scopes subagent-node parity OUT. Not driven: no real Copilot child-session shape exists to capture with one tiny prompt.
- [x] E-7: Resume a Copilot session across a Fredo restart — do rows upsert (no duplicates) and does `seq` continue monotonically, or does it restart/collide?
  - **PASS** — see F-11 (real `-Action Restart` + identical re-export → one row per key, `seq = 1`, provider unchanged). Promoted into F-11.
- [x] E-8: Deliver the same exchange twice with an identical `correlationId` — are rows deduped by composite key, or is a parallel row created at the same `startedAtNs` (the #2932 F-11 parallel-row class)?
  - **PASS** — see F-8 (two end-to-end runs + a third replay after restart: one row per composite key; no parallel row at the same `startedAtNs`; `seq` not inflated). Promoted into F-8.

## Degradation / failure

- [ ] E-9: Strip/deny the credential env at capture time — is the failure non-silent, and are NO partial/empty rows written?
  - **N/A by mechanism (named).** The CLI authenticates itself; Fredo holds NO Copilot credential in this slice (no `OTEL_EXPORTER_OTLP_HEADERS`, no token store), so there is no Fredo-side credential env to strip. Not drivable as written.
- [ ] E-10: Hit a free-tier quota/rate limit mid-turn (before tool response) — what does the row store show, and does a later retry duplicate the turn?
  - **UNVERIFIED (named blocker).** Free-tier quota could not be exhausted in-sandbox (and deliberately was not driven to exhaustion). The plan-authorised **injected error signal** leg stands in: `bun .opencode/tmp/2933/post-bad-otlp.ts` → 2 live `WARN` "export dropped, no rows classified" rows; distinct-key counts stable; no orphan/partial row; re-export after the error is a no-op (F-8/F-11).
- [ ] E-11: Kill the Fredo IPC socket during a hooks-mechanism capture — does the Copilot turn stall, error, or proceed (non-blocking hook)?
  - **N/A by mechanism** — native OTel export, no hook in the agent loop (N-1).
- [x] E-12: Run capture with the OTLP receiver unavailable (native-export mechanism) — is the drop observable (a log/signal), never a silent zero-row result?
  - **PASS (loud failure).** `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --port 4999 …` → exit 1 with *"FAILED: OTLP/HTTP export … did not complete … the telemetry rows CANNOT exist"*; zero rows for `e2e-copilotnorecv2933`. The producer never silently reports success.

## Latency / ordering

- [ ] E-13: Order-of-arrival: response before init, or tool response before tool init — does the classifier still produce a coherent row (no orphan/empty)?
  - **UNVERIFIED (named blocker).** A single OTLP/HTTP POST carries the spans as one ordered batch; splitting an export into out-of-order partial POSTs is not reachable with the in-repo producer. The shape is pinned in-repo instead (`copilot_capture_tests.rs`: response-before-init partial exchange → coherent chat row, no orphan, no double-write).
- [ ] E-14: High-volume burst (many Copilot spans in one export) — do all rows land, and do batches chunk correctly (>512 rows) without loss?
  - **UNVERIFIED (named blocker).** `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --count 600` does NOT produce a burst: `--count` drives only the orphan/delegation gRPC modes; `--copilot` builds one fixed 3-span envelope (script header `Params`; `runCopilotMode` ignores `count`). No in-repo Copilot bulk producer; the >512 chunking is the existing flush behaviour pinned by the realtime-data suite.
- [x] E-15: Ingest latency — a Copilot row visible within the OpenCode flush-cadence bound; record both.
  - **PASS** — see N-4: rows present on the first read immediately after the POST; no polling; no material excess vs the OpenCode control in the same run.

## Mechanism-dependent (`[mech]`)

- [ ] E-16: If BOTH mechanisms can run at once (hooks + native export), does a single Copilot turn produce DUPLICATE rows (same turn captured twice)? This is a real cross-transport dedupe risk — probe it explicitly.
  - **N/A by mechanism** — the architecture decision is native OTel export ONLY; no hook is installed, so the cross-transport duplicate is structurally impossible in this slice.
- [x] E-17: Does the captured `model` value match the actual Copilot model for the turn, or a static/default value?
  - **PASS (live).** Real turn: `gen_ai.request.model = "auto"` but `gen_ai.response.model = "mai-code-1.1-flash"` and the row's `model = mai-code-1.1-flash` — the RESOLVED model, not the static request token.

## Round notes

> (Tester appends per-round results here — a confirmed finding promotes to `functional.md` as a new `F-` row keeping the origin note.)

- **Round 1 — 2026-09-24, `spec/2933 @ 69ce5850`:** E-1/E-2/E-3/E-4/E-5/E-7/E-8/E-12/E-15/E-17 PASS; E-6 / E-9 / E-11 / E-13 / E-14 / E-16 not driven (named reasons above). Deterministic repro fixtures authored under `.opencode/tmp/2933/`: `copilot-turn-split.fixture.json` (the real two-chat-span turn shape), `copilot-partial.fixture.json` (partial content + multi-part prompt + two tools), `post-bad-otlp.ts` (rejected-export signal), `copilot-http-driver.ts` (real-CLI OTel env driver).
