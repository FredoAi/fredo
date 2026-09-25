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

## Hotkeys smoke round 1 — result (FAIL — served app does not boot)

**Blocking finding (round 1):** the SERVED app (`apps/tauri` dev entry, port 5174)
never mounts. Vite fails at import-analysis on the spec branch tip `e823a07a`:

```
[plugin:vite:import-analysis] Failed to resolve import "@/shared/utils/colorTint"
from "../ui/src/shared/components/hotkeys/Keycap.tsx". Does the file exist?
```

Root cause: `Keycap.tsx` (new ST-3 file) uses the `@/` alias, but the SERVED
`apps/tauri/vite.config.ts` resolves `@` → `apps/tauri/src` (only `main.tsx` lives
there) — NOT `apps/ui/src` where the module actually is. `apps/ui/vite.config.ts`
does resolve `@` → `apps/ui/src`, which is why `pnpm --filter @fredo/ui build` and
`test:run` are green while the shipped webview is blank. Same class as G-251
(library green, served host broken).

Second blocking finding: the SERVED entry `apps/tauri/src/main.tsx` never imports or
mounts `HotkeysProvider` (only the standalone `apps/ui/src/main.tsx` does), so even
with the alias fixed the engine/announcer/which-key overlay would be absent from the
shipped webview.

- [ ] S-1: App window renders — **FAIL.** `document.getElementById('root')` has 0
      children; `tauri_webview_dom_snapshot` body = `div#root` + `vite-error-overlay`
      (3 elements). The React tree never mounts.
- [ ] S-2: No console errors — **FAIL.** Webview console is empty (tree never runs);
      the Vite dev-server overlay carries the fatal import-analysis error instead.
- [ ] S-3: Hotkeys surface reachable — **FAIL (blocked).** Settings/Hotkeys pane
      unreachable; no app UI at all. `document.documentElement` has no
      `data-fredo-hotkeys-engine` attribute.
- [ ] S-4: Telemetry Settings accessible — **FAIL (blocked).** No Settings window UI.
- [ ] S-5: Screenshot captured — **PASS (mechanically).** `.opencode/tmp/2946/e2e/baseline.jpeg`
      and `.opencode/tmp/2946/e2e/fail-vite-overlay.jpeg` captured; the latter shows
      the Vite error overlay (uploaded as user-attachment in the `## Tests Runs` verdict).
- [ ] S-6: Ctrl+Space still opens the launcher — **FAIL (blocked).** No engine, no launcher.
- [ ] S-7: A leader sequence shows pending hints — **FAIL (blocked).** No engine.
- [ ] S-8: A text field suppresses bare shortcuts — **FAIL (blocked).** No text field.
- [ ] S-9: CI-parity gate — **PARTIAL.** `pnpm --filter @fredo/ui build` exit 0;
      `pnpm --filter @fredo/ui test:run` 157 files / 2256 tests ALL PASS. These gates
      do NOT exercise the served `apps/tauri` entry, so they cannot catch this defect
      (see `.github/workflows/validate.yml` ui-validate: typecheck + build + test:run).

**Smoke verdict: FAIL (0/9 fully passing).** All live legs blocked by the app-wide
boot failure. CI-suite parity alone does not evidence the served app.
