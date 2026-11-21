# Companion Embedded Engine — Smoke

> Standardized smoke checks for the in-process companion engine (Spec #3141). Adapt the counts
> to the app. Evidence: `tauri_webview_dom_snapshot` / `tauri_webview_screenshot` /
> `tauri_read_logs(source="console")`. **Verification policy: live** — LIVE WEBVIEW receipt; no
> `telemetry_spans` needed (this feature emits no OTLP producer of its own).

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
      non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Settings (gear) → Companion renders (the wizard on a
      not-ready machine, or the normal companion controls on a ready machine). With model files
      **installed** the **backend mode control** is present in BOTH branches (below the wizard when
      not ready — AC-25's recovery path); with model files **missing** it is absent.
- [ ] **S-4:** Telemetry Settings accessible — the settings dialog opens with sections/nav
      visible.
- [ ] **S-5:** Screenshot captured —
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3141/e2e/smoke.jpeg")`
      succeeds.
- [ ] **S-6:** No external tool offered — the Companion section renders **no** `Install
      llama.cpp` action and **no** `llama-server` prerequisite step; the ready-path prerequisite
      list is the model files only.
- [ ] **S-7:** Engine start quick path — with the model files present, `launch_llama_server`
      reaches a loaded engine within the bounded start budget; `get_llama_server_status`
      reports `running:true` / `healthy:true`, `port` and `pid` carry no live value, and
      `backend` + `devices` are populated from the engine's typed device list.
- [ ] **S-8:** One quick chat turn — a short companion prompt streams (≥2 distinct partial
      contents sampled) and settles with exactly one `llm-done`; no `llama-server` process
      exists in the process table during or after the turn.
- [ ] **S-9:** No orphan / no leftover socket — after exiting Fredo the process table shows no
      `llama-server` image and the old managed port is free (independent process-table + port
      probe, not the app's own readout).
