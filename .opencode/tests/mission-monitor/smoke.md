# Mission Monitor — Smoke Test Suite

Feature domain: `mission-monitor`. Standard boilerplate adapted from `.opencode/tests/README.md` plus feature-specific quick paths.
Round 2: S-4 re-opened — Run CLI must actually launch (the AC1 method depends on it); the round-1 "environment issue" self-resolution is not acceptable.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Cases

- [x] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`. **PASS (2026-08-12, round 1):** DOM snapshot shows full app structure.

- [x] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`. **PASS (2026-08-12, round 1):** no product errors; ResizeObserver benign.

- [x] S-3: **Mission Monitor surface reachable** — the Mission Monitor toolbar item/entry renders the panel with its expected elements (graph canvas, session list). **PASS (2026-08-12, round 1).** Re-confirm on round-2 sessions.

- [ ] S-4: **Run CLI launches a session (RE-OPENED).** The Run CLI entry renders its launch panel AND actually launches the opencode window (the AC1 verification method depends on it). Round-1 note (2026-08-12): panel showed "Launching..." indefinitely and the tester self-resolved with `opencode run` — INVALIDATED. Round 2: if "Launching..." persists after one retry, STOP and report a `Question` blocker; do not substitute another launch method.

- [ ] S-5: **Telemetry Settings accessible** — gear/nav opens the settings dialog with sections visible.

- [x] S-6: **ECE contract registration on mount** — opening Mission Monitor emits `registerEventContracts()` (visible via IPC monitor / delivery traffic) before any session runs (G-012 ordering). **PASS (2026-08-12, round 1).** Re-confirm on round-2 sessions.

- [x] S-7: **Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2711/e2e/smoke.jpeg")` succeeds. **PASS (2026-08-12, round 1):** multiple screenshots captured.
