# navigation-fleet — Smoke

Feature: NavigationEngine P7 fleet migration (Spec #3121). Short, standardized checks that the app
boots, the five migrated surfaces mount, and the two hardest paths (terminal passthrough, window
traversal) still work. Five surfaces only: terminal, window traversal, mission-monitor, SQL Studio
(`database-client`), dev-mode.

> Policy: **live** (running desktop app). Execute on the `spec/3121` build, dev-env UP, shipped MCP
> driver. A failed smoke check halts the round before the functional suite.

## Cases

- [ ] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a
      non-empty `<body>` on the main window.
- [ ] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`,
      `Uncaught`, or `Maximum update depth exceeded`.
- [ ] S-3: **Mission Monitor mounts** — open Mission Monitor from the launcher; the window renders
      `[data-nav-surface="bar"]`, `[data-nav-surface="trail"]` and a non-empty
      `navigation-bar-breadcrumb`.
- [ ] S-4: **Terminal route boots** — the `?view=terminal` webview renders
      `[data-testid="terminal-entry-root"]`; spawn `spawn_terminal_session{cli:"shell"}` and confirm
      a PTY pane appears.
- [ ] S-5: **Terminal passthrough host hook** — with the PTY focused,
      `document.body[data-fredo-passthrough]` is `"true"`; clicking the session sidebar clears it.
- [ ] S-6: **Window traversal** — with ≥2 windows, `Ctrl+Tab` changes the focused window and
      `Ctrl+Shift+Tab` returns; `Ctrl+Space` toggles the launcher.
- [ ] S-7: **SQL Studio mounts** — open SQL Studio from the launcher (`database-client`); the window
      renders `[data-testid="db-client-root"]`, `[data-testid="db-query-editor"]`, and the
      `[data-nav-surface="bar"]` footer with a non-empty breadcrumb.
- [ ] S-8: **Dev Mode opens** — the Konami sequence `ArrowUp ArrowUp ArrowDown ArrowDown ArrowLeft
      ArrowRight ArrowLeft ArrowRight b a` (10 keys, lowercase `b`/`a`, no modifier —
      `shared/hooks/useKonamiCode.ts:3-14`) on Home opens the Dev Mode window and it renders
      `dev-mode-view-toggle`.
- [ ] S-9: **Telemetry Settings accessible** — the gear/nav opens the settings dialog with sections
      visible (regression smoke; unrelated to this spec but part of the boilerplate).
- [ ] S-10: **Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/3121/e2e/smoke.jpeg")` succeeds.
- [ ] S-11: **Build + suite gate** — `pnpm --filter @fredo/ui build` exit 0 (zero warnings) and
      `pnpm --filter @fredo/ui test:run` exit 0.
