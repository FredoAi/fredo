# Companion Vision — Smoke

> Standardized smoke checks for the companion vision path (issue **#3234**, re-scoped
> 2026-11-26). Adapt the counts/labels to the app. Evidence: `tauri_webview_dom_snapshot` /
> `tauri_webview_screenshot` / `tauri_read_logs(source="console")` / a live `get_llama_server_status`.
> **Verification policy: live** — the live-policy `telemetry_spans` receipt for this feature is the
> harness's own `companion.score` span set (smoke `S-6`).

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
      non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` /
      `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Companion surface reachable — the companion chat/reply surface renders and the engine
      reaches `running:true` / `healthy:true` within the bounded start budget (`get_llama_server_status`).
- [ ] **S-4:** Telemetry Settings accessible — the settings dialog opens with sections/nav visible.
- [ ] **S-5:** Screenshot captured —
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3234/e2e/smoke.jpeg")`
      succeeds.
- [ ] **S-6:** Vision quick path — one screen-region capture (`capture_screen_region`) fed through
      `llm_chat_with_image` streams ≥1 `llm-token` and settles with exactly one `llm-done`; no
      `llm-error`. Then `fredo companion score --report .opencode/tmp/3234/score.json` runs to a JSON
      report whose **two** committed screen-region fixtures (`vision-screen-text` + `vision-dense-text`)
      both pass at the pinned budget, records the dense case's prompt-token count (**772**), and
      persists `companion.score` spans to `telemetry_spans`.
- [ ] **S-7:** Audio quick path unchanged — a model-audio turn carries exactly one `input_audio` part
      and settles once (no transcript text; cross-ref `companion-embedded-engine` F-9).
