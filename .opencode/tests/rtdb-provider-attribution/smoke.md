# RTDB Provider Attribution — Smoke Tests (Spec #2932)

> App-boots + core-path sanity for provider attribution. Run first on this feature's testing phase. `fredo emit` requires the dev:tauri instance running and the `fredo` binary built (`fredo-cli-events` skill). Bound tokens: `open_code` / `copilot_cli` / `internal` / `unknown`.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — Mission Monitor opens and lists sessions (the row pipeline still delivers); the Stepper Probe readout hydrates (row subscription alive)
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [ ] S-6: `provider` column exists on all three row tables — `PRAGMA table_info(chat_rows)` / `tool_use_rows` / `agent_session_rows` via `telemetry-query.ps1` each list a `provider` column
- [ ] S-7: No empty provider on rows — `SELECT COUNT(*) AS empty_provider FROM chat_rows WHERE provider IS NULL OR provider = ''` returns 0 (also for `tool_use_rows` / `agent_session_rows`)
- [ ] S-8: Distinct-provider injection smoke — `& $fredoBin emit --event-type chat --state init --provider copilot_cli --session-id <e2e-guid>` succeeds and `SELECT provider FROM chat_rows WHERE session_id = '<e2e-guid>'` returns exactly `copilot_cli`
- [ ] S-9: OpenCode attribution smoke — `SELECT provider, COUNT(*) FROM chat_rows GROUP BY provider` shows OpenCode-origin rows under `open_code` (and no row carrying a model provider such as `openai`/`anthropic`)
- [ ] S-10: Query-language smoke — `chat(sessionId = "<s>") { provider, userMessage }` validates and returns rows with a `provider` field (no `has no field 'provider'`)
