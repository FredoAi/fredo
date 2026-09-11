# Llama Setup — Smoke

> Standardized smoke checks for the guided llama.cpp setup wizard domain (seeded at Spec #2855).
> Short, high-signal: app boots + the Companion settings / wizard surface is reachable. Evidence:
> `tauri_webview_dom_snapshot` / `tauri_webview_screenshot` / `tauri_read_logs(source="console")`.
> **Verification policy: live.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — open Settings (gear) → Companion; the section renders (either the llama setup wizard on a not-set-up machine, or the normal companion controls on a set-up machine).
- [ ] S-4: Telemetry Settings accessible — the settings dialog opens with its sections/nav visible.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2855/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: Wizard quick path — on a not-set-up machine the wizard shows both prerequisite rows (`llama-server` + model files) with a per-row state, and no normal companion controls are rendered.
