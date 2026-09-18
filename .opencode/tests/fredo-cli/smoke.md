# Fredo CLI — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the `fredo` CLI surface.
> **Verification policy: live** — every step quotes the literal command output + exit code.
> **Prerequisites:** the `fredo` binary on PATH; the app running for S-4.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: CLI reachable — `fredo --help` exits 0 and lists the commands (including the new open
      command); the binary resolves on PATH (`where.exe fredo`).
- [ ] S-4: Open quick path — `fredo open-app mission-monitor` against the running app opens Mission
      Monitor with a success outcome; `tauri_webview_screenshot` succeeds.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/2893/e2e/smoke.jpeg")` succeeds.
