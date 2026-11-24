# opencode-plugin - Functional

Durable test suite for the Fredo OpenCode plugin emitter domain. Spec #2680 additions tested 2026-08-10.

## Spec #2680 additions (GenAI full-convention coverage: renames, events, new metrics)

- [x] F-14: Renamed keys emitted **PASS**
- [x] F-15: Legacy keys gone for new data **PASS**
- [x] F-16: Exception emitted as a span event **PASS**
- [x] F-17: No new exception log records **PASS**
- [x] F-18: Operation-details emitted as a span event **PASS**
- [x] F-19: No new details log records **PASS**
- [x] F-20: Four new metrics emitted **PASS**
- [x] F-21: Out-of-scope metrics absent **PASS**
- [x] F-22: Non-streaming/non-agent edge **PASS**

## Spec #3197 additions (OpenCode 2 / V2 plugin port) — live policy

> The V1-era PASSes above (F-14..F-22, 2026-08-10) assert the emitted key vocabulary and MUST be
> re-run in this round: the port changes the entry point and event source, not the contract.
>
> Environment contract for every row below (see the plan's QA section): one isolated env
> (`dev-env.ps1 -Action Up -Spec 3197 -EnvId <lease envId> -EnvSlot <slot> -RequireIsolation`),
> store reads via `telemetry-query.ps1 -Manifest .opencode/tmp/envs/<envId>/manifest.json`, plugin
> built at the spec tip and installed via the native path with a matching `Get-FileHash`.
> The external-client lever is `scripts/run-external-session.ps1` (copy it to `.opencode/tmp/3197/`
> first — only `.opencode/scripts/*` and `.opencode/tmp/*` scripts are executable in the sandbox).

- [ ] F-23 (R-1 / AC1 — an external session is captured): run the external lever OUTSIDE Fredo with
  prompt marker `AC1-MARK-<rnd>`; resolve the session by the marker in `prompt`; list its spans.
  - EXPECTED: ≥1 `fredo.session`, ≥1 `fredo.llm`, ≥1 `fredo.tool.<name>` for that session, each with
    a non-null `gen_ai.operation.name` and `end_time_ns`.
  - DATA: `SELECT span_name, status_code, attributes_json::jsonb ->> 'gen_ai.operation.name' AS op,
    end_time_ns FROM telemetry_spans WHERE session_id='<sid>' ORDER BY start_time_ns`.
- [ ] F-24 (R-1.1): the turn-root session span attributes.
  - EXPECTED: `op=run_agent`, `session.id`/`gen_ai.conversation.id`/`agent`/`model` non-empty,
    `agent.type=primary`, `is_subagent` false, `prompt` contains the marker.
- [ ] F-25 (R-1.2): the model-turn span attributes.
  - EXPECTED: `op=chat`, `gen_ai.provider.name` non-empty, **`gen_ai.system` NULL** (current
    registry name only), `gen_ai.request.model` non-empty, `gen_ai.input.messages` parses as a JSON
    array carrying the marker, `gen_ai.output.messages` non-empty, `gen_ai.usage.input_tokens` /
    `output_tokens` numeric ≥ 0 on a completed span.
- [ ] F-26 (R-1.3): the tool span attributes.
  - EXPECTED: `op=execute_tool`, `gen_ai.tool.name` matches the span-name suffix,
    `gen_ai.tool.call.id` non-empty, `gen_ai.tool.call.arguments` is a parseable JSON string,
    flat `tool_input` / `tool_name` / `tool_call_id` / `agent` / `agent.type` all non-empty.
- [ ] F-27 (R-1.4): child→parent attribution for a real @-subagent dispatch.
  - EXPECTED: child session carries `session.parent_id`, `agent.type=subagent`, `is_subagent` true,
    and/or its link carries `parent.session_id` + `relationship.type=parent-child`.
  - DEGRADED: if V2 exposes no parent id and the pending-`task` scan cannot resolve it, record a
    **named degraded observable** (evidence: the `FREDO_CAPTURE_EVENTS` JSONL `session.created`
    payload) and flag it for the Product Owner. Never fabricate a parent id.
- [ ] F-28 (R-2 / AC2 — no V1 plugin warning, global load, BOTH clients):
  (a) external client (lever log from F-23); (b) Fredo-launched client via Terminal.
  - EXPECTED: both clients produce rows (the plugin LOADED), exit 0, and the captured client log
    contains no `plugin … skip|unsupported|invalid|v1|failed to load` line. The producer-side row is
    the gate — "Mission Monitor looks empty/quiet" is never a PASS.
  - NOTE: `GET /api/plugin` (if reachable) is optional, non-gating corroboration only.
- [ ] F-29 (R-2.1, static corroboration): the artifact is V2-shaped only.
  - EXPECTED: `apps/opencode-plugin/package.json` declares `@opencode/plugin` (exact pin) and NOT
    `@opencode-ai/plugin`; `src/index.ts` default-exports a `Plugin.define({ id: "fredo" … })`; no V1
    hook-object (`server:` / `hooks:`) export exists; `dist/index.js` contains the plugin id.
  - NOTE: never a substitute for F-28's live legs; dual-export is a FAIL even if the live legs pass.
- [ ] F-30 (R-3 / AC3 — the contract is preserved, immutable): run
  `scripts/verify-contract-immutable.ps1` (copied into `.opencode/tmp/3197/`).
  - EXPECTED: `CONTRACT-DIFF-EMPTY: true`, `EXITCODE=0`, for `rtdb/attrs.rs` **and** `rtdb/ingest.rs`,
    at the same tip the live legs ran on; quote the resolved `BASE=<ref>@<sha>` and `HEAD=<branch>@<sha>`.
  - TOOLING: `EXITCODE=3` / `CONTRACT-DIFF-EMPTY: unknown` is NO VERDICT (git missing, no base ref,
    or a path absent from base and worktree) — report it as tooling, never as a PASS.
- [ ] F-31 (R-3 / AC3 — render): the captured external session renders in Mission Monitor.
  - EXPECTED: session listed; selecting it shows the prompt marker under `── USER ──`, the model
    turn, `── TOOLS (N) ──` with the tool, and non-empty token usage; at the same instant
    `chat_rows` / `tool_use_rows` / `agent_session_rows` / `feature_mission_monitor_sessions` are
    non-empty for `<sid>` and carry the same prompt text.
  - DATA: screenshot → `upload-evidence` → `user-attachments` URL + the `SELECT *` row dumps.
- [ ] F-32 (R-3.1): classification is operation-name driven.
  - EXPECTED: every span of the session has `gen_ai.operation.name` ∈ {`run_agent`,`chat`,
    `execute_tool`}; `chat_rows` and `tool_use_rows` counts ≥ 1 (nothing dropped at ingest).
- [ ] F-33 (R-3.2): preserved log bodies.
  - EXPECTED: `telemetry_logs` for the session has records whose `event.name` is
    `session.created`, `user_prompt`, `api_request`, `tool_result`, `session.idle` (plus
    `session.error` on the F-35 session).
- [ ] F-34 (R-3.3): the git-commit signal is a LOG body.
  - LEVER: `scripts/run-external-session.ps1 -WorkDir <path> -InitRepo` (round-2 parameters), where
    `<path>` is a throwaway repo under `.opencode/tmp/3197/e2e/` (gitignored) — never the
    spec-branch checkout. `-InitRepo` creates/`git init`s it, sets a local identity and seeds one
    commit, so no bare `git` is needed. Paste the lever's `WORKDIR=` / `WORKDIR_GIT=` / `INITREPO=`
    receipt lines; a run with `WORKDIR_GIT=false` commits into the ENCLOSING repo and is not valid
    evidence for this row.
  - EXPECTED: a record with `event.name=commit` for the session that committed (marker
    `AC3C-MARK-<rnd>`). Query `telemetry_logs`, never `telemetry_spans` — there is no `fredo.commit`
    span and none should be invented.
- [ ] F-35 (R-4 / AC4 — full session shape in ONE session): prompt → tool success → tool failure →
  interruption, driven in Fredo's Terminal (PTY is the interrupt lever; see the plan's test data).
  - EXPECTED: in that one `session_id`: the prompt text, a tool input AND output, a tool-span
    `ERROR` with error text, and the interruption (session-span `ERROR` + `status_message`).
- [ ] F-36 (R-4.1): the failed tool call.
  - EXPECTED: ≥1 `fredo.tool.%` row with `status_code=ERROR`, `tool.success=false`, non-empty
    `tool.error`, and `gen_ai.client.operation.exception` in `events_json`.
- [ ] F-37 (R-4.2): the interruption (SPAN-shaped evidence only).
  - EXPECTED: session span `status_code=ERROR` with a `status_message` naming the interruption, and
    every other span of the session has `end_time_ns` set (the open-span sweep ran).
- [ ] F-38 (R-4.3): assistant text / reasoning.
  - EXPECTED: `response_text` / `output` / `gen_ai.output.messages` carry the assistant's reply;
    `agentThinking` non-empty IF the configured model emitted reasoning (else record
    "no reasoning emitted by the configured model" — not a FAIL).
- [ ] F-39 (R-4.4): permission decision as the `tool_decision` log body.
  - EXPECTED: ≥1 `event.name=tool_decision` record with `decision` / `source` / `tool_name`.
  - DEGRADED: if the host config auto-approves every tool (no ask inducible without editing host
    config), record a named degraded observable + the ST-5 `src/handlers/permission.test.ts` pin.
- [ ] F-40 (R-5 / AC5 — opt-out, with control): external lever run once with `FREDO_TELEMETRY` UNSET,
  once with `-TelemetryOptOut 0` (repeat `off`).
  - EXPECTED: control session → rows; opt-out session → **0** `telemetry_spans` AND **0**
    `telemetry_logs` rows, exit 0, reply text present, no fredo/plugin error line in the log.
  - NOTE: the var is stamped into the CLIENT's own process env by the lever. Setting it in the
    tester's shell for an already-running Fredo-hosted service is the WRONG lever (technique FAIL).
- [ ] F-41 (R-5.1): default-on — the F-40 **control** run produced rows with no opt-in variable set.
- [ ] F-42 (NFR-1): a failed export never breaks the session — lever with `-OtlpEndpoint` pointing at
  a confirmed-free loopback port.
  - EXPECTED: exit 0, reply text present, no user-visible error. Zero spans is EXPECTED here.
- [ ] F-43 (NFR-3): diagnostic quiet — at most one plugin-attributable startup line, none an error;
  the opt-out log carries zero fredo-referencing lines.
- [ ] F-44 (NFR-5): bounded memory — **NOT live-tested in this round** (declared, not asserted; the
  unit pin over `setBoundedMap`/`MAX_PENDING` is corroboration only, never an AC PASS).
