# navigation-retirement — Smoke

App-boots + core-path sanity for Issue #3151 (the navigation-engine removal). Smoke runs first on
every testing phase that touches this feature's surface.

Verification policy: **MIXED** — S-1/S-2/S-5 are `live`; S-3/S-4 are `live` with a `static`
confirmation. See `functional.md` for the per-row policy statement.

- [ ] **S-1: App window renders.** `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>` with `[data-testid="launcher-command-bar"]` present on the home desktop.
  Evidence: the snapshot + a `user-attachments` URL.
- [ ] **S-2: No console errors.** `tauri_read_logs(source="console", lines=50)` shows no `Error:` /
  `Uncaught` / `Maximum update depth exceeded` — in particular no failed module import from the
  retired barrel lines (`apps/ui/src/index.ts:91,94`).
- [ ] **S-3: Every retained application still opens.** From the launcher, open `wireframe`,
  `terminal`, `mission-monitor`, `database-client`, `settings`, `setup`, `theming`; Dev Mode via
  the ten-stroke Konami sequence. Each renders its window frame
  (`[data-testid="window-frame-<id>"]`) and a non-empty content region. A window that opens blank is
  a FAIL — the deleted providers were mounted in these shells.
- [ ] **S-4: The three chords still work at the desktop.** `primary+Space` raises the launcher
  (`aria-expanded` false→true); with ≥2 windows, `primary+Tab` / `primary+Shift+Tab` step focus.
  Evidence: `tauri_webview_find_element` receipts.
- [ ] **S-5: Screenshot captured.**
  `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3151/e2e/smoke.jpeg")`
  succeeds; upload it and embed the `user-attachments` URL.
- [ ] **S-6: The committed absence guard runs clean.** (static, but run it first — a red guard means
  the deletion landing is incomplete.) `run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-retired.ps1"`
  → `EXITCODE=0`; then `-SelfTest` → `EXITCODE=0`.
- [ ] **S-7: The build gates are green.** (static) `pnpm --filter @fredo/ui build`; `cargo check`;
  the CI-parity clippy — all `EXITCODE=0`, zero warnings.
