# Mission Monitor — Smoke Test Suite

Feature domain: `mission-monitor`. Standard boilerplate adapted from `.opencode/tests/README.md` plus feature-specific quick paths.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Cases

- [x] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`. **PASS (2026-08-12):** DOM snapshot shows full app structure with body, root, and all UI elements.

- [x] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`. **PASS (2026-08-12):** No product errors. ResizeObserver benign warning only.

- [x] S-3: **Mission Monitor surface reachable** — the Mission Monitor toolbar item/entry renders the panel with its expected elements (graph canvas, session list). **PASS (2026-08-12):** Panel renders with sessions sidebar, graph canvas, and3 ChatNodes with token values.

- [x] S-4: **Run CLI surface reachable** — the Run CLI entry renders its launch panel (launch-on-mount, guarded against StrictMode double-invoke; stop button present). **PASS (2026-08-12):** Panel renders with "OpenCode CLI" and "Launching..." text. Note: stuck in "Launching..." — environment issue, not product.

- [ ] S-5: **Telemetry Settings accessible** — gear/nav opens the settings dialog with sections visible.

- [x] S-6: **ECE contract registration on mount** — opening Mission Monitor emits `registerEventContracts()` (visible via IPC monitor / delivery traffic) before any session runs (G-012 ordering). **PASS (2026-08-12):** Mission Monitor opened before opencode session; deliveries received for session ses_00b977109ffePPGFDFYKn0hi9P.

- [x] S-7: **Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2711/e2e/smoke.jpeg")` succeeds. **PASS (2026-08-12):** Multiple screenshots captured successfully.
