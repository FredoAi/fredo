# GitHub Copilot CLI Capture — Smoke Tests (Spec #2933)

> App-boots + core-path sanity for Copilot capture. Run first on this feature's testing phase. `fredo emit` requires the dev:tauri instance running and the `fredo` binary built (`fredo-cli-events` skill). Bound provider tokens: `open_code` / `claude_code` / `copilot_cli` / `internal` / `unknown`.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — Mission Monitor opens and lists sessions (the row pipeline still delivers); the Stepper Probe readout hydrates (row subscription alive)
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [ ] S-6: Row tables present with the `provider` column — `PRAGMA table_info(chat_rows)` / `tool_use_rows` / `agent_session_rows` via `telemetry-query.ps1` each list a `provider` column
- [ ] S-7: OTLP gRPC receiver live — a `telemetry-query.ps1` `SELECT COUNT(*), MAX(timestamp) FROM telemetry_spans` is non-zero with a recent timestamp (the receiver the mocked Copilot fixture posts to is up)
- [ ] S-8: Deterministic mocked producer present + runs — `.opencode/scripts/inject-otlp-fixture.ts` supports `--copilot` and `.opencode/scripts/copilot-exchange.fixture.json` exists in-repo; `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` exits 0 with a non-silent per-span receipt (trace/span hex printed). If the `--copilot` mode / fixture is missing, this is a FAIL of the spec deliverable (QA-1), not a sandbox blocker.
- [ ] S-9: Copilot smoke row — after S-8, `SELECT provider, COUNT(*) FROM chat_rows WHERE session_id LIKE 'e2e-%' GROUP BY provider` shows the injected session's rows under exactly `copilot_cli`
- [ ] S-10: OpenCode attribution still healthy — `SELECT provider, COUNT(*) FROM chat_rows GROUP BY provider` shows OpenCode-origin rows under `open_code` (0 model-provider rows such as `openai`/`anthropic`)
- [ ] S-11: No credentials in rows — `SELECT COUNT(*)` over `raw_json` / `attributes_json` / `telemetry_logs` message for `LIKE '%GITHUB_TOKEN%' OR LIKE '%ghp_%' OR LIKE '%gho_%'` = 0
- [ ] S-12: Windows shell check — `copilot --version` under a PowerShell 6+ shell returns a version (or the named blocker is recorded); never assume Windows PowerShell 5.1

## Round notes

> (Tester appends per-round results here — PASS with evidence; FAIL keeps `- [ ]` with expected-vs-actual.)
