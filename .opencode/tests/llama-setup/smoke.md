# Llama Setup — Smoke

> Standardized smoke checks for the guided llama.cpp setup wizard domain (seeded at Spec #2855).
> Short, high-signal: app boots + the Companion settings / wizard surface is reachable. Evidence:
> `tauri_webview_dom_snapshot` / `tauri_webview_screenshot` / `tauri_read_logs(source="console")`.
> **Verification policy: live.**

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] S-3: Feature surface reachable — open Settings (gear) → Companion; the section renders (either the llama setup wizard on a not-set-up machine, or the normal companion controls on a set-up machine).
- [x] S-4: Telemetry Settings accessible — the settings dialog opens with its sections/nav visible.
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2855/e2e/smoke.jpeg")` succeeds.
- [x] S-6: Wizard quick path — on a not-set-up machine the wizard shows both prerequisite rows (`llama-server` + model files) with a per-row state, and no normal companion controls are rendered.

## Execution Log — round 1 (2026-09-11, spec/2855 @ c5c29c42)

All six smoke checks PASS live. S-1 body non-empty; S-2 console clean (only pre-existing
`motion() is deprecated` warning) checked after every interaction; S-3 gear → Companion renders
the wizard (MS-3: llama missing / models installed); S-4 settings nav visible; S-5
`.opencode/tmp/2855/e2e/*.jpeg` captured; S-6 `companion-step-llama-server` +
`companion-step-model-files` rendered with per-row state, `companion-controls` query = 0.

**Note:** the real `Install llama.cpp` action FAILs deterministically (wrong exact winget id) —
see functional F-08/F-17.
