# resident-shell — Smoke Tests

> Standard app-boots + core-path sanity for the resident shell (#3192). Live policy: every row is
> observed on the served `spec/3192` build.

- [ ] **S-1: App window renders** —
  `tauri_webview_dom_snapshot(type="structure")` on `main` returns a non-empty `<body>`.
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no
  `Error:` / `Uncaught` / `Maximum update depth exceeded` on `main`. Repeat it after the S-5 reopen
  and again on the surviving `terminal` window (re-point the driver first — the tool reads the
  CURRENTLY TARGETED webview); that second read is N-6's required leg (`functional.md`), so paste
  both reads with their window label.
- [ ] **S-3: Tray surface present** — `…invoke('app_lifecycle_status')` returns
  `trayItems === [{"id":"tray-open","label":"Open"},{"id":"tray-quit","label":"Quit"}]` and
  `mainWindowOpen === true`. (The icon itself is OS chrome and is not DOM-inspectable; the menu
  read-back is the smoke check.)
- [ ] **S-4: Close keeps the process resident** — close `main` with
  `…invoke('plugin:window|close', { label: 'main' })`; `tauri_manage_window(action="list")` no longer
  lists `main`; `lifecycle-probe.ps1 -Action App -ManifestPath <manifest>` reports `APP_ALIVE=True`.
- [ ] **S-5: Reopen restores the window** — `…invoke('open_main_window')` returns
  `{recreated:true,focused:true}`; `tauri_manage_window(action="list")` lists `main` again; a DOM
  snapshot of the recreated window is non-empty.
- [ ] **S-6: Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3192/e2e/smoke.jpeg")` succeeds after the reopen (bonus evidence only — the
  DOM snapshot + invoke receipts are the record if the upload channel is down, G-104).
