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

- [ ] F-1 (R-1, mocked path — REQUIRED): run `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` (fixture → real receiver `:4317` → real classifier), then
  `SELECT session_id, provider, COUNT(*) FROM chat_rows WHERE session_id = '<e2e-guid>' GROUP BY session_id, provider` (repeat `tool_use_rows`, `agent_session_rows`), plus `SELECT COUNT(*) FROM chat_rows WHERE session_id = '<e2e-guid>' AND (provider IS NULL OR provider = '')`.
  - EXPECTED: ≥1 row in EACH of the three tables for the session; every row's `provider` = exactly `copilot_cli`; NULL/empty = 0.
  - Edge: empty/short exchange (no tool call); Init-before-Response streaming; a session whose only row is a tool row; classes landing out of order.
- [ ] F-2 (R-1, delivery to a feature): subscribe `useEventRows('chat' | 'toolUse' | 'agentSession', { sessionId: '<e2e-guid>' })`; capture deliveries via `tauri_ipc_monitor` / `tauri_get_captured` (or the Stepper Probe readout).
  - EXPECTED: the Copilot session's rows are delivered live; each delivery patch exposes `provider`; the terminal envelope carries `replayCompleteQueryId` (deterministic settle, no hang); Mission Monitor lists the session.
  - Edge: subscription registered before replay vs after; a scoped arg with no matching rows → empty + settle.
- [ ] F-3 (R-1, real-drive leg — best-effort): run the `copilot` CLI directly in a scratch project under PowerShell 6+ (free tier), execute a prompt that triggers ≥1 tool call, then query the three row tables for the session.
  - EXPECTED: same three row classes with `provider = copilot_cli`.
  - **Named blocker clause:** if `copilot` is absent/unauthorized/free-tier quota-exhausted in the sandbox, record a **named blocker** and mark this leg **UNVERIFIED — not PASS**; F-1/F-2 (mocked) still clear the mapping.
  - Edge: quota hits mid-session (→ F-8); the supported shell differs from Windows PowerShell 5.1.

## R-2 (AC2) — prompt/reply/tokens/model/tool parity with OpenCode

- [ ] F-4 (R-2, chat parity): run the mocked prompt → 1 tool call → reply exchange; read the session's `chat_rows` (`userMessage`, `agentReply`, `promptTokens`, `completionTokens`, `cacheReadTokens`, `model`) and compare against an OpenCode-shaped exchange under a distinct session id.
  - EXPECTED: `userMessage` = the prompt; `agentReply` = the reply; `promptTokens`/`completionTokens` are the **per-turn delta** (`#2711`/`#2723` — a row whose values equal the session-cumulative input is a FAIL); `model` = the Copilot model id. Every field class OpenCode populates is present and non-null.
  - Edge: multi-turn session; `cacheReadTokens` present/absent; content disabled (→ F-6).
- [ ] F-5 (R-2, tool parity): read the session's `tool_use_rows` (`toolName`, `toolInputJson`, `toolOutputJson`, `toolSuccess`, `durationMs`).
  - EXPECTED: `toolName` = the tool name; `toolInputJson` carries the arguments; `toolOutputJson` carries the result; `toolSuccess` = `true`; the tool row is linked to the turn (same session/correlation family as the chat row).
  - Edge: tool failure (`toolSuccess = false` + `toolError` non-empty); empty result JSON; a tool call with arguments hidden (content off); no tool call (parity for chat-only).

## R-3 (AC3) — content-off default still yields structural rows (or a documented, non-silent degradation)

- [ ] F-6 (R-3, content disabled): run the same exchange with prompt/response/tool-argument content DISABLED (Copilot's default), then read the three row tables.
  - EXPECTED: structural rows still exist (≥1 per class; `provider` + timing + token totals + `model` + tool name + `toolSuccess` present). Content fields are either populated or explicitly absent **with the plan/report stating a precise, non-silent degradation marker**. UI-side observable (per UI/UX cross-review): the existing `—` placeholder / hidden-section behavior in Mission Monitor (`ChatNode.tsx` USER/RESPONSE, `DetailPanel.tsx` Input/Output) — sparse but legible, never blank/broken chrome. Zero rows = FAIL; "content off" indistinguishable from a broken extractor = FAIL.
  - Edge: partial enable (prompt on / response off); tool arguments hidden but tool name/success shown; single-turn.
- [ ] F-7 (R-3, content-enabled positive control): run the same shape with content ENABLED.
  - EXPECTED: content fields are populated (proves the extractor works and the disabled run's absence is the documented degradation, not an extractor defect).
  - Edge: only one content channel enabled at a time.

## R-4 (AC4) — deterministic mocked path + quota/rate-limit degradation, no duplication

- [ ] F-8 (R-4, determinism + no duplication): run the committed mocked producer twice end to end (no paid subscription, no network/auth); compare row key sets across runs; then repeat one identical `correlationId` within a run.
  - EXPECTED: run 1 and run 2 reproduce the same key set; **no duplicate row per composite key** (`sessionId` + `correlationId`; `seq` monotonic, no parallel row at the same `startedAtNs`); the mocked path needs no Copilot auth.
  - Edge: a partial exchange (chat without tool); concurrent duplicate exports; Fredo IPC socket unavailable (the producer must fail loudly, not silently).
- [ ] F-9 (R-4, quota/rate-limit): exercise a free-tier session (or an injected quota/error signal) that hits a quota/rate limit mid-session.
  - EXPECTED: a **clear degradation signal** is observable (a logged warning / row state / error event); the distinct-key count stays stable; no corrupted or duplicated rows; no partial row that later double-writes.
  - Edge: quota hit before any row; quota hit between tool init and response; a resumed session after a quota hit.

## R-5 (AC5) — OpenCode path unchanged; both providers coexist without cross-contamination

- [ ] F-10 (R-5, isolation): produce an OpenCode-shaped exchange AND a Copilot-shaped exchange under distinct session ids in one store; read both.
  - EXPECTED: OpenCode rows keep `provider = open_code` with an unchanged field set/shape; Copilot rows `copilot_cli`; **no row's provider flips**; no session/correlation key collision; Mission Monitor lists both without merging.
  - Edge: a Copilot session id crafted to collide with an OpenCode id pattern; composited child rows (`parentSessionId` / `compositedChildSessionId`) preserved.
- [ ] F-11 (R-5, resumed session): restart Fredo and re-ingest the SAME Copilot session id and exchange.
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
