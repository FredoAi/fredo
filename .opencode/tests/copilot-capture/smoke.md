# GitHub Copilot CLI Capture — Smoke Tests (Spec #2933)

> App-boots + core-path sanity for Copilot capture. Run first on this feature's testing phase. `fredo emit` requires the dev:tauri instance running and the `fredo` binary built (`fredo-cli-events` skill). Bound provider tokens: `open_code` / `claude_code` / `copilot_cli` / `internal` / `unknown`.

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [x] S-3: Feature surface reachable — Mission Monitor opens and lists sessions (the row pipeline still delivers); the Stepper Probe readout hydrates (row subscription alive)
- [x] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [x] S-6: Row tables present with the `provider` column — `PRAGMA table_info(chat_rows)` / `tool_use_rows` / `agent_session_rows` via `telemetry-query.ps1` each list a `provider` column
- [x] S-7: OTLP gRPC receiver live — a `telemetry-query.ps1` `SELECT COUNT(*), MAX(timestamp) FROM telemetry_spans` is non-zero with a recent timestamp (the receiver the mocked Copilot fixture posts to is up)
- [x] S-8: Deterministic mocked producer present + runs — `.opencode/scripts/inject-otlp-fixture.ts` supports `--copilot` and `.opencode/scripts/copilot-exchange.fixture.json` exists in-repo; `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` exits 0 with a non-silent per-span receipt (trace/span hex printed). If the `--copilot` mode / fixture is missing, this is a FAIL of the spec deliverable (QA-1), not a sandbox blocker.
- [x] S-9: Copilot smoke row — after S-8, `SELECT provider, COUNT(*) FROM chat_rows WHERE session_id LIKE 'e2e-%' GROUP BY provider` shows the injected session's rows under exactly `copilot_cli`
- [x] S-10: OpenCode attribution still healthy — `SELECT provider, COUNT(*) FROM chat_rows GROUP BY provider` shows OpenCode-origin rows under `open_code` (0 model-provider rows such as `openai`/`anthropic`)
- [x] S-11: No credentials in rows — `SELECT COUNT(*)` over `raw_json` / `attributes_json` / `telemetry_logs` message for `LIKE '%GITHUB_TOKEN%' OR LIKE '%ghp_%' OR LIKE '%gho_%'` = 0
- [x] S-12: Windows shell check — `copilot --version` under a PowerShell 6+ shell returns a version (or the named blocker is recorded); never assume Windows PowerShell 5.1

## Round notes

> (Tester appends per-round results here — PASS with evidence; FAIL keeps `- [ ]` with expected-vs-actual.)

### Round 1 — 2026-09-24, `spec/2933 @ 69ce5850` — ALL PASS

- **S-1 PASS** — non-empty `<body>` (3 children) after `dev-env.ps1 -Action Up -Spec 2933`.
- **S-2 PASS** — 0 console `Error:`/`Uncaught`/`Maximum update depth exceeded` (only a pre-existing `motion()` deprecation WARN).
- **S-3 PASS** — Mission Monitor opened; 14 session rows listed incl. all 3 Copilot fixtures; the Stepper Probe row path is the same `useEventRows` store (verified by the live delivery capture, F-2).
- **S-4 PASS** — Settings surface opened with the sidebar sections visible (Companion / Appearance / Fredo Setup / Telemetry + feature sections My Work Items / Infrastructure Diagram / Model Storage / Run CLI); Telemetry was NOT opened (G-145 wedge avoided).
- **S-5 PASS** — `.opencode/tmp/2933/e2e/smoke.jpeg` captured.
- **S-6 PASS** — `pragma_table_info` lists a `provider` column on `chat_rows`, `tool_use_rows`, `agent_session_rows`.
- **S-7 PASS** — `fredo::otlp` logged `HTTP receiver listening` / `gRPC receiver listening`; `telemetry_spans` has recent rows.
- **S-8 PASS** — `inject-otlp-fixture.ts` supports `--copilot` (also `--content-off`/`--fixture`); `.opencode/scripts/copilot-exchange.fixture.json` exists; the documented command exits 0 with a per-span trace/span hex receipt.
- **S-9 PASS** — the injected session's rows appear under exactly `copilot_cli`.
- **S-10 PASS** — OpenCode-origin rows are `open_code`; **0** model-provider rows (`openai`/`anthropic`); the `unknown` rows are pre-existing non-Copilot debris.
- **S-11 PASS** — credential scan = 0 (token-shaped patterns).
- **S-12 PASS** — `copilot --version` → `GitHub Copilot CLI 1.0.88.`

### Round 2 — 2026-09-24, `spec/2933 @ c96ab4dd` — ALL PASS (fixed surface: ST-3R classifier carry)

- **S-1 PASS** — non-empty DOM (accessibility snapshot, 99 elements) after `dev-env.ps1 -Action Up -Spec 2933` then `-Action Restart -Spec 2933`.
- **S-2 PASS** — console clean (see CR-7).
- **S-3 PASS** — Mission Monitor opened and listed sessions incl. the split Copilot fixture; `useEventRows` delivery alive (live `fredo-stream-event` capture on the Chat query).
- **S-4 PASS (inherited)** — the round-2 diff contains **no UI/settings file** (`git diff --stat origin/main HEAD`); the Settings surface is untouched since round 1's live PASS (Telemetry section deliberately not opened — G-145 wedge).
- **S-5 PASS** — screenshots captured under `.opencode/tmp/2933/e2e/`.
- **S-6 PASS** — `pragma_table_info` lists `provider TEXT NOT NULL DEFAULT 'unknown'` on `chat_rows` / `tool_use_rows` / `agent_session_rows`.
- **S-7 PASS** — `fredo::otlp` logged `HTTP receiver listening` + `gRPC receiver listening` post-restart (16:45:51); `telemetry_spans` = 2627 rows.
- **S-8 PASS** — `inject-otlp-fixture.ts --copilot --fixture <path>` accepts both committed fixtures; each exits 0 with a non-silent per-span trace/span receipt and `EXPORT 1/1 -> OK (http 200)`.
- **S-9 PASS** — `e2e-copilotsplit2933` / `e2e-copilot2933` / `e2e-copilotoff2933r2` rows appear under exactly `copilot_cli`.
- **S-10 PASS** — `open_code` **2607** chats; 0 model-provider rows.
- **S-11 PASS** — credential scan = 0 (refined patterns; self-reference residual disclosed).
- **S-12 PASS** — `copilot --version` → `GitHub Copilot CLI 1.0.88.`
