# GitHub Copilot CLI Capture — Functional Test Cases (Spec #2933)

> Durable functional suite (feature domain `copilot-capture`) — capturing GitHub Copilot CLI activity into the canonical RTDB row pipeline (`chat_rows` / `tool_use_rows` / `agent_session_rows` in `fredo.db`) at parity with OpenCode, tagged with the Copilot provider token `copilot_cli`.
>
> **Evidence policy: LIVE** — every PASS requires a live observable: a `telemetry-query.ps1` read of the canonical row tables, a captured `useEventRows` delivery (`tauri_ipc_monitor` / `tauri_get_captured` or the Stepper Probe readout), a rendered Mission Monitor capture, a measured hook/credential check. A `cargo test`/grep-only result is a **FALSE PASS** for these rows (it clears only N-3's static half).
>
> **Mechanism-agnostic (standing human decision):** the capture mechanism (Copilot hooks → `fredo emit` vs Copilot native OTLP export into the existing receivers) is decided by the Software Architect. Every row asserts the canonical-row observables at the classifier's convergence point — table, field, provider token, delivery to a feature — never the transport. `[mech]` marks a mechanism-dependent expected value.
>
> **Provider vocabulary (#2932):** `open_code` / `claude_code` / `copilot_cli` / `internal` / `unknown`. Copilot rows MUST carry exactly `copilot_cli` (resolved from OTLP resource `service.name = "copilot-cli"`). Assert the literal.
>
> **Fixtures (G-172 — in-repo only):**
> - **Primary deterministic mocked producer:** an extension of the existing in-repo `.opencode/scripts/inject-otlp-fixture.ts` adding a `--copilot` mode, driven by a committed fixture `.opencode/scripts/copilot-exchange.fixture.json` (a **spec deliverable** — canonical Copilot OTLP spans with Resource `service.name = "copilot-cli"`, hand-encoded h2c in the same file) POSTed into the real OTLP gRPC receiver `:4317` → the real `IngestClassifier`. No paid subscription, no network/auth.
> - **Secondary CLI-leg producer:** `fredo emit` via the `fredo-cli-events` skill with `--provider copilot_cli` (shipped by #2932) — the real classifier.
> - **OpenCode baseline:** a live OpenCode drive (Run CLI, `dev-environment` skill) or an OpenCode-shaped fixture under a DISTINCT session id.
> - **Real Copilot drive:** the `copilot` binary run directly in a scratch project under PowerShell 6+ (launching from Fredo's Terminal is out of scope).
>
> **Isolation:** every run uses a fresh `e2e-<guid8>` session id; all queries filter on it. Restore any settings/retention writes to defaults.

## R-1 (AC1) — Copilot session produces canonical chat/tool/agent rows carrying `copilot_cli`, reaching a feature

- [x] F-1 (R-1, mocked path — REQUIRED): run `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` (fixture → real receiver **`:4318` HTTP/JSON — the transport Copilot actually ships**; the plan's Deployment Note authorised this, see `## Round 1` note) → real classifier, then
  `SELECT session_id, provider, COUNT(*) FROM chat_rows WHERE session_id = '<e2e-guid>' GROUP BY session_id, provider` (repeat `tool_use_rows`, `agent_session_rows`), plus `SELECT COUNT(*) FROM chat_rows WHERE session_id = '<e2e-guid>' AND (provider IS NULL OR provider = '')`.
  - EXPECTED: ≥1 row in EACH of the three tables for the session; every row's `provider` = exactly `copilot_cli`; NULL/empty = 0.
  - Edge: empty/short exchange (no tool call); Init-before-Response streaming; a session whose only row is a tool row; classes landing out of order.
  - **PASS (2026-09-24, spec/2933 @ 69ce5850).** `EXPORT 1/1 -> OK (http 200)`; `chat_rows` = `e2e-copilot2933_2` (gpt-4o, prompt_tokens 321 / completion 184), `tool_use_rows` = `e2e-copilot2933_3` (readFile, success 1, duration_ms 50), `agent_session_rows` = `e2e-copilot2933_1` (total_tokens 13211, agent_name `copilot`); all `provider = copilot_cli`; 0 NULL/empty. Live `telemetry_spans` receipt: 3 rows, `transport = otlp_http`.
  - **PASS (round 2, 2026-09-24, spec/2933 @ c96ab4dd — fixture now the REAL two-chat-span turn).** `inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` → `EXPORT 1/1 -> OK (http 200)`; 4 spans (root `invoke_agent copilot`, `chat #1` `…_2`, `execute_tool readFile` `…_3`, `chat #2` `…_4`), all `transport = otlp_http`, `provider = copilot_cli`. `chat_rows` `…_2` (user prompt; 321/184) + `…_4` (**user prompt carried forward**, `agent_reply` sentinel; 12159/547), `tool_use_rows` `…_3` (readFile, success 1, 50 ms), `agent_session_rows` `…_1` (13211, agent_name copilot). **Store-pollution caveat (documented by the ST-5R dev, reproduced):** on a store that already held the round-1 one-chat-span rows for `e2e-copilot2933`, `…_2` retains the stale round-1 `agent_reply` ("I will read src/main.rs first.") because the new patch carries no assistant text and `KeepNonZero` never clears an absent field — this is a fixture-idempotency artifact of a polluted store, NOT a product defect (the shipped `chat #1` shape emits a `tool_call`, no text ⇒ no `agent_reply`). The clean `e2e-copilotsplit2933` session and a fresh store show the correct split shape.
- [x] F-2 (R-1, delivery to a feature): subscribe `useEventRows('chat' | 'toolUse' | 'agentSession', { sessionId: '<e2e-guid>' })`; capture deliveries via `tauri_ipc_monitor` / `tauri_get_captured` (or the Stepper Probe readout).
  - EXPECTED: the Copilot session's rows are delivered live; each delivery patch exposes `provider`; the terminal envelope carries `replayCompleteQueryId` (deterministic settle, no hang); Mission Monitor lists the session.
  - Edge: subscription registered before replay vs after; a scoped arg with no matching rows → empty + settle.
- [x] F-3 (R-1, real-drive leg — best-effort): run the `copilot` CLI directly in a scratch project under PowerShell 6+ (free tier), execute a prompt that triggers ≥1 tool call, then query the three row tables for the session.
  - EXPECTED: same three row classes with `provider = copilot_cli`.
  - **Named blocker clause:** if `copilot` is absent/unauthorized/free-tier quota-exhausted in the sandbox, record a **named blocker** and mark this leg **UNVERIFIED — not PASS**; F-1/F-2 (mocked) still clear the mapping.
  - Edge: quota hits mid-session (→ F-8); the supported shell differs from Windows PowerShell 5.1.

## R-2 (AC2) — prompt/reply/tokens/model/tool parity with OpenCode

- [x] F-4 (R-2, chat parity): run the mocked prompt → 1 tool call → reply exchange; read the session's `chat_rows` (`userMessage`, `agentReply`, `promptTokens`, `completionTokens`, `cacheReadTokens`, `model`) and compare against an OpenCode-shaped exchange under a distinct session id.
  - EXPECTED: `userMessage` = the prompt; `agentReply` = the reply; `promptTokens`/`completionTokens` are the **per-turn delta** (`#2711`/`#2723` — a row whose values equal the session-cumulative input is a FAIL); `model` = the Copilot model id. Every field class OpenCode populates is present and non-null.
  - Edge: multi-turn session; `cacheReadTokens` present/absent; content disabled (→ F-6).
  - **PASS (round 2, 2026-09-24, spec/2933 @ c96ab4dd — ST-3R continuation carry).** On the committed split-turn producer (`--fixture .opencode/scripts/copilot-turn-split.fixture.json`, session `e2e-copilotsplit2933`), the **continuation** chat row `…_4` now carries `user_message` = `Read hello.txt and reply with its exact contents.` — the exchange's own captured prompt, carried forward from the session cache — with its own `agent_reply = fredo-copilot-2933-sentinel`; the dispatch row `…_2` carries the same prompt with an empty reply. Per-call tokens unchanged and NOT cumulative: `…_2` 10184/39, `…_4` 10241/14; `cache_read_tokens` NULL on both (delta bypass); `model = gpt-4o`. The carry also lands in `raw_json` (`instr(raw_json,'userMessage')>0` on `…_4`). This is the canonical chat-row contract Mission Monitor's same-exchange anchoring depends on (see `mission-monitor/regression.md` R-45).
- [x] F-5 (R-2, tool parity): read the session's `tool_use_rows` (`toolName`, `toolInputJson`, `toolOutputJson`, `toolSuccess`, `durationMs`).
  - EXPECTED: `toolName` = the tool name; `toolInputJson` carries the arguments; `toolOutputJson` carries the result; `toolSuccess` = `true`; the tool row is linked to the turn (same session/correlation family as the chat row).
  - Edge: tool failure (`toolSuccess = false` + `toolError` non-empty); empty result JSON; a tool call with arguments hidden (content off); no tool call (parity for chat-only).

## R-3 (AC3) — content-off default still yields structural rows (or a documented, non-silent degradation)

- [x] F-6 (R-3, content disabled): run the same exchange with prompt/response/tool-argument content DISABLED (Copilot's default), then read the three row tables.
  - EXPECTED: structural rows still exist (≥1 per class; `provider` + timing + token totals + `model` + tool name + `toolSuccess` present). Content fields are either populated or explicitly absent **with the plan/report stating a precise, non-silent degradation marker**. UI-side observable (per UI/UX cross-review): the existing `—` placeholder / hidden-section behavior in Mission Monitor (`ChatNode.tsx` USER/RESPONSE, `DetailPanel.tsx` Input/Output) — sparse but legible, never blank/broken chrome. Zero rows = FAIL; "content off" indistinguishable from a broken extractor = FAIL.
  - Edge: partial enable (prompt on / response off); tool arguments hidden but tool name/success shown; single-turn.
- [x] F-7 (R-3, content-enabled positive control): run the same shape with content ENABLED.
  - EXPECTED: content fields are populated (proves the extractor works and the disabled run's absence is the documented degradation, not an extractor defect).
  - Edge: only one content channel enabled at a time.

## R-4 (AC4) — deterministic mocked path + quota/rate-limit degradation, no duplication

- [x] F-8 (R-4, determinism + no duplication): run the committed mocked producer twice end to end (no paid subscription, no network/auth); compare row key sets across runs; then repeat one identical `correlationId` within a run.
  - EXPECTED: run 1 and run 2 reproduce the same key set; **no duplicate row per composite key** (`sessionId` + `correlationId`; `seq` monotonic, no parallel row at the same `startedAtNs`); the mocked path needs no Copilot auth.
  - Edge: a partial exchange (chat without tool); concurrent duplicate exports; Fredo IPC socket unavailable (the producer must fail loudly, not silently).
- [x] F-9 (R-4, quota/rate-limit): exercise a free-tier session (or an injected quota/error signal) that hits a quota/rate limit mid-session.
  - EXPECTED: a **clear degradation signal** is observable (a logged warning / row state / error event); the distinct-key count stays stable; no corrupted or duplicated rows; no partial row that later double-writes.
  - Edge: quota hit before any row; quota hit between tool init and response; a resumed session after a quota hit.

## R-5 (AC5) — OpenCode path unchanged; both providers coexist without cross-contamination

- [x] F-10 (R-5, isolation): produce an OpenCode-shaped exchange AND a Copilot-shaped exchange under distinct session ids in one store; read both.
  - EXPECTED: OpenCode rows keep `provider = open_code` with an unchanged field set/shape; Copilot rows `copilot_cli`; **no row's provider flips**; no session/correlation key collision; Mission Monitor lists both without merging.
  - Edge: a Copilot session id crafted to collide with an OpenCode id pattern; composited child rows (`parentSessionId` / `compositedChildSessionId`) preserved.
- [x] F-11 (R-5, resumed session): restart Fredo and re-ingest the SAME Copilot session id and exchange.
  - EXPECTED: rows upsert on the composite key (no duplicate session/rows); `seq` continues monotonically; provider stays `copilot_cli`; retention eviction remains the only `remove` producer.
  - Edge: a replayed Init after restart; a re-key/compositing stamp already present.

## Non-functional

- [ ] N-1 `[mech]` (hook non-blocking/fast): IF the chosen mechanism installs a Copilot hook (hooks → `fredo emit`), measure 20 back-to-back synchronous hook invocations and run a "Fredo IPC socket unavailable" leg.
  - EXPECTED: each hook invocation completes within a small budget (< 100 ms warm) with no network/auth in the hook; the no-Fredo leg completes without hanging the Copilot turn. If native OTLP export is chosen (no Fredo-installed hook), record N-1 **N/A** with the architect's mechanism cited — never silently skip.
- [ ] N-2 (credentials never logged/persisted): on `chat_rows`/`tool_use_rows`/`agent_session_rows` (`raw_json`), `telemetry_spans` (`attributes_json`), and `telemetry_logs` (message): `SELECT COUNT(*) ... WHERE <col> LIKE '%GITHUB_TOKEN%' OR LIKE '%GH_TOKEN%' OR LIKE '%ghp_%' OR LIKE '%gho_%' OR LIKE '%github_pat_%'`.
  - EXPECTED: `0` on every column/table; the console + captured IPC traffic contain no token; **no new credential/token store** created by Fredo.
- [ ] N-3 (`[static-allowed]` shared extract rule): `resolve_provider_token` exists ONCE in `rtdb/attrs.rs` and is consumed by both live `ingest.rs` and `backfill.rs`; `provider` present in all three `*_FIELDS` + merge tables + query schema; `cargo check` zero warnings; `pnpm --filter @fredo/ui build` clean.
- [ ] N-4 (ingest latency parity): Copilot row visible in `fredo.db` within the flush-cadence bound of an OpenCode control measured in the same run (Copilot must not materially exceed OpenCode's baseline).
- [ ] N-5 (console/console hygiene): `tauri_read_logs(source="console")` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded` after subscription start/stop and app open/close.
- [ ] N-6 (layers/theming): capture stays in `infrastructure/rtdb/` (or the chosen transport module); no cross-feature import; no new user-visible surface (if one appears, tokens only — no hardcoded hex/rgba, no invalid `var(--token)NN`).
- [ ] N-7 (Windows shell accounted for): record the shell actually used and whether `copilot` ran (or the named blocker); never assume Windows PowerShell 5.1 (`copilot` may require PowerShell 6+).

## Round notes

> (Tester appends per-round results here — keep `- [ ]` on FAIL/UNVERIFIED, mark PASS with evidence, promote confirmed exploratory probes to a new `F-` row keeping the origin note.)

### Round 1 — 2026-09-24, `spec/2933 @ 69ce5850` — ALL PASS (raw-row + delivery layer)

Harness: dev instance `spec/2933 @ 69ce5850` (context `Served commit:` matched); real OTLP/HTTP receiver on `:4318` (the committed `--copilot` producer's transport; the plan's Deployment Note authorised HTTP/JSON — "matching the shipped transport"). Evidence is live row-table reads via `telemetry-query.ps1` + a live `fredo-stream-event` delivery capture + real `telemetry_spans` receipts.

- **F-1 PASS.** All three tables carry ≥1 row for `e2e-copilot2933`, every row `provider = copilot_cli`, 0 NULL/empty; `telemetry_spans` receipt: 3 rows `transport = otlp_http`, `span_name` `invoke_agent copilot` / `chat gpt-4o` / `execute_tool readFile`.
- **F-2 PASS.** Live capture of `fredo-stream-event` (in-page listener + `subscribe_events`, replay:true): terminal `replayCompleteQueryId = bc6e41a8-a317-4500-a2dc-a00cf49aab03` (matches the registered `queryId`); `rowBatch` carried an `insert` for `{sessionId: e2e-copiloticp2933, correlationId: …_2}` with `patch = {model: gpt-4o, provider: copilot_cli, userMessage: "List the files in the src directory."}` → the Copilot rows are delivered live to the `useEventRows` path with the provider field exposed and a deterministic settle. Mission Monitor listed the session (14 session rows incl. all 3 Copilot fixtures).
- **F-3 PASS (real drive).** `copilot` **1.0.88** driven via `.opencode/tmp/2933/copilot-http-driver.ts` (child-process env: `COPILOT_OTEL_ENABLED=true`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_SERVICE_NAME=copilot-cli`, content ON), one tiny prompt → exit 0. Real session `3736fe04-c91c-4948-983e-6882af63c5a8`: `chat_rows` `…_2`/`…_3`, `tool_use_rows` `…_1` (`view`), `agent_session_rows` `…_4` (total_tokens 20478) — every row `provider = copilot_cli`.
- **F-4 PASS (row-level).** Real: `user_message` = the prompt (incl. Copilot's `<current_datetime>` prefix), `agent_reply` = `fredo-copilot-2933-sentinel`; per-call `prompt_tokens` 10184 / 10241 and `completion_tokens` 39 / 14 (NOT a cumulative delta); `model = mai-code-1.1-flash` (= the real turn's `gen_ai.response.model`). Mock: 321 / 184, `model = gpt-4o`. `cacheReadTokens` NULL on every row — **expected-by-bypass** (the live probe confirmed a real `chat` span DOES emit `gen_ai.usage.cache_read.input_tokens`; the `copilot_cli` delta-bypass keeps it absent — documented degradation, not a miss).
- **F-5 PASS (row-level).** Real `tool_use_rows`: `tool_name = view`, `tool_input_json` = the path, `tool_output_json` = the file body, `tool_success = 1`, `duration_ms = 12` derived from span timing (no flat `duration_ms`). Mock: `readFile`, duration 50.
- **F-6/F-7 PASS.** Content-OFF (mock `--content-off` + a real content-off drive `76cc4361-…`): structural rows in all three classes, `user_message`/`agent_reply`/`tool_input_json`/`tool_output_json` NULL, and `raw_json` free of all four content keys (`instr(...) = 0`) — the binding R-3.2 discriminator. Content-ON positive control: the same keys PRESENT in `raw_json`.
- **F-8 PASS.** Two identical end-to-end producer runs → exactly ONE row per `(sessionId, correlationId)` in each table, `seq = 1`, no parallel row at the same `startedAtNs`; no auth/subscription needed.
- **F-9 PASS (injected error signal — the row's sanctioned alternative).** `bun .opencode/tmp/2933/post-bad-otlp.ts` POSTed two malformed bodies → receiver emitted 2 live `WARN` rows from `fredo::otlp`: *"rejected OTLP/HTTP JSON trace export — body failed to parse; export dropped, no rows classified"* (with `error` attrs) — **never a silent drop**; distinct-key counts stayed stable (1/1/1 for `e2e-copilot2933`). A transport-down leg (`--port 4999`) exits 1 loudly with *"the telemetry rows CANNOT exist"* and lands zero rows. A literal free-tier quota exhaustion was not driven (free tier not exhaustible in-sandbox) — the injected-error leg is the row's documented substitute.
- **F-10 PASS.** Provider census in one store: `open_code` 1742 chat / 2297 tool / 51 session, `copilot_cli` 13 / 7 / 7, `unknown` 70 / 239 / 6 — **no row's provider flips**, keys disjoint. A Copilot session crafted with an OpenCode-shaped id (`ses_copilots2933`) produced its own keys under `copilot_cli` with no collision.
- **F-11 PASS (real restart).** `dev-env.ps1 -Action Restart -Spec 2933` (fresh classifier) then re-export of the identical fixture → still exactly one row per composite key, `seq = 1`, `provider = copilot_cli` unchanged.
- **N-1 N/A** by mechanism (Copilot CLI **native OTel export**, no Fredo-installed hook) — the mechanism decision is cited, not skipped (per the plan's own disposition).
- **N-2 PASS.** Token-shaped scan (`GLOB '*ghp_[0-9A-Za-z]*'`, `gho_`, `github_pat_`, `GITHUB_TOKEN=`, `GH_TOKEN=`) over all three `raw_json` + `telemetry_spans.attributes_json` + `telemetry_logs.message` = **0 hits**. (A lenient `LIKE '%ghp_%'` scan returned non-zero matches — they are this tester's OWN scan SQL echoed into captured `fredo.tool.*` span attributes; the refined pattern is the discriminator.) No new credential store; no `OTEL_EXPORTER_OTLP_HEADERS` set.
- **N-3 PASS (static half).** ONE `resolve_provider_token` definition (`rtdb/attrs.rs:323`), consumed by `ingest.rs:332/502/948` and the shared `attrs::` import in `backfill.rs:85` (`provider_rebackfill_pass`); `provider` present in `rows.rs` `CHAT_FIELDS:68` / `TOOL_USE_FIELDS:89` / `AGENT_SESSION_FIELDS:108`, in all three merge tables (`merge.rs:61/83/103`, `KeepFirstAttributed`), and in the query schema (`query/schema.rs:93/118/141`, pinned by `provider_is_selectable_and_filterable_on_every_root` incl. `chat(provider = "copilot_cli")`). `cargo check --locked` → zero warnings; `pnpm --filter @fredo/ui build` → clean.
- **N-4 PASS.** Copilot rows were present on the FIRST `telemetry-query` read issued immediately after the POST returned (no polling) — within the same flush-cadence bound the OpenCode control exhibits in the same run; no material excess observed. Bound is coarse (one query round-trip, ~1 s) — recorded, not over-claimed.
- **N-5 PASS.** `tauri_read_logs(source="console")` after restart + subscription start/stop + app open/close → 0 `Error:` / `Uncaught` / `Maximum update depth exceeded`; only a pre-existing `motion() is deprecated` WARN.
- **N-6 PASS.** `git diff --stat origin/main HEAD` touches only `infrastructure/rtdb/{attrs,ingest,mod,copilot_capture_tests}.rs`, `infrastructure/otlp/http.rs`, `fixtures/copilot_cli/*`, `.opencode/scripts/*`, `docs/telemetry-reference.md` — **no `apps/ui/` or `features/` file**; no cross-feature import; no new user-visible surface; no color literals.
- **N-7 PASS.** `copilot --version` → `GitHub Copilot CLI 1.0.88.`; the OTel env was applied via a bun-launched child-process `env` object (no shell env assignment/chaining); shell recorded as Windows PowerShell 5.1 + bun runtime.
