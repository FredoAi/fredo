# Hotkeys — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the hotkey
> surface (issue #2946). Runs on a RUNNING Fredo desktop app on the `spec/2946` build
> (dev-env UP, MCP driver `com.fredo.app`).
>
> **Verification policy: live** — every case's evidence carries a `telemetry_spans`
> live-run receipt for its drive window plus the DOM/screenshot assertion. A static-only
> PASS fails closed.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Hotkeys surface reachable — open Settings (launcher tile `[role="button"][aria-label="Settings"]`), select the Hotkeys section, and confirm the single binding listing renders (both tiers or, with no feature focused, the global tier)
- [ ] S-4: Telemetry Settings accessible — the Settings window renders its sections (Companion, Appearance, Fredo Setup, Telemetry + discovered features) alongside Hotkeys
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2946/e2e/smoke.jpeg")` succeeds

## Hotkey quick paths

- [ ] S-6: **Ctrl+Space still opens the launcher.** From the resting desktop, press Ctrl+Space. **Expected:** the launcher bar appears with the caret in `input[role="searchbox"]`; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-7: **A leader sequence shows pending hints.** Press the leader prefix on a non-text surface. **Expected:** a which-key overlay appears naming the pending prefix + valid next keys; pressing Escape resets it with no action; screenshot succeeds; console clean.
- [ ] S-8: **A text field suppresses bare shortcuts.** Focus a text-entry field (e.g. `[data-testid="launcher-command-input"]`) and type a bare key bound to a feature shortcut. **Expected:** the character lands verbatim in the field and NO action fires; screenshot succeeds; console clean.
- [ ] S-9: **CI-parity gate.** Run `pnpm --filter @fredo/ui build` (expect exit 0, zero TypeScript errors), `pnpm --filter @fredo/ui test:run` (expect green), and the repo lint/typecheck leg. **Expected:** all pass with no weakened/disabled assertion.

## Hotkeys smoke round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_
