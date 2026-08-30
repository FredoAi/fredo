# Event persistence exploratory tests

Unscripted probes — add findings on the fly; confirmed findings promote to `functional.md` as `F-<n>` rows (keep the origin note).

- [ ] E-1 Probe: kill/restart the app between persist and hydrate — does hydration survive a full app restart (not just feature close)?
- [ ] E-2 Probe: drive many sessions until the store holds thousands of rows, then hydrate — hydration latency and UI responsiveness under a large replay set.
- [ ] E-3 Probe: corrupt/lock the SQLite file (external handle) — does the writer degrade gracefully (drop persistence work, never deliveries) without console errors?
- [ ] E-4 Probe: two features hydrating the same session concurrently (Mission Monitor + stepper-probe) — interference, ordering, or duplicated state?
- [ ] E-5 Probe: session that never completes (no end span) — hydration returns the partial Init/Update chain without hanging; buffer timeout interplay.
- [ ] E-6 Probe: retention knob set to 0 — is the store effectively disabled, and does the app still function (no error loop)?
- [x] E-1 → RESOLVED round 2: hydration survives a FULL app restart (twice) — F5 re-rendered identically after two cold restarts + two prune cycles; even with contract rows pruned, the FeatureStore retained the graph (promoted to regression R-6 note).
- [ ] E-7 FINDING (round 2): FeatureStore (`feature_mission_monitor_events`) and `contract_events` have independent lifecycles — the retention prune touches ONLY `contract_events`; a pruned session degrades to its FeatureStore-retained events with zero errors. Promoted to functional F-3 / regression R-6.
- [ ] E-8 FINDING (round 2): `sleep N` does NOT exist in the opencode bash tool on Windows (PowerShell) — it fails in ~8 ms, collapsing strict-window fixtures (R2B tree completed in 19 s, pre-close). Strict-window fixtures must use `Start-Sleep -Seconds N` inside the subagent's tool call, or a second sequential subagent, to guarantee closed-window completions.
- [ ] E-9 FINDING (round 2): the Tauri MCP bridge drops command args (`open_run_cli` workDir, `write_pty_input` data, `resize_pty` rows/cols all report "missing required key"). Workaround: invoke from INSIDE a webview via `window.__TAURI__.core.invoke(name, args)`. Note: `open_run_cli` therefore falls back to USERPROFILE cwd — harmless for echo fixtures (the fredo plugin is globally installed).
- [ ] E-10 FINDING (round 2): opencode TUI model picker via `/models` opens with the filter pre-filled ("/models" → "No matching items"; backspace-on-empty closes the dialog). Reliable path: ctrl+p → type `model` → Enter → "Select model" list → Enter (first Recent entry). Used for both round-2 drives (Muse Spark 1.2 Free · OpenCode Zen · Free).
