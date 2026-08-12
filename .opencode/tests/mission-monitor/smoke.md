# Mission Monitor — Smoke Test Suite

Feature domain: `mission-monitor`. Standard boilerplate adapted from `.opencode/tests/README.md` plus feature-specific quick paths.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Cases

- [ ] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.

- [ ] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.

- [ ] S-3: **Mission Monitor surface reachable** — the Mission Monitor toolbar item/entry renders the panel with its expected elements (graph canvas, session list).

- [ ] S-4: **Run CLI surface reachable** — the Run CLI entry renders its launch panel (launch-on-mount, guarded against StrictMode double-invoke; stop button present).

- [ ] S-5: **Telemetry Settings accessible** — gear/nav opens the settings dialog with sections visible.

- [ ] S-6: **ECE contract registration on mount** — opening Mission Monitor emits `registerEventContracts()` (visible via IPC monitor / delivery traffic) before any session runs (G-012 ordering).

- [ ] S-7: **Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2711/e2e/smoke.jpeg")` succeeds.
