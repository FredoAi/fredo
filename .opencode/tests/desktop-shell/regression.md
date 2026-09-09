# desktop-shell — Regression Tests

> "Did we break existing behavior?" — the no-change baseline from the plan's non-goals
> (NFR-A) for issue #2817 (clean desktop shell removal). Run on every testing phase that
> touches the shell launch surface.

## R-1 — Shell chrome unchanged

- [x] R-1: The launcher / search-or-command bar / online clock / pixel-butler avatar / window system / stream-status behavior is unchanged (no behavior change beyond the removal).
  - Evidence: FREDO notch ("Fredo launcher" button), ONLINE clock (time + ONLINE dot), Settings gear all render; opening the notch reveals the pixel-butler avatar + `>` "Search or command" searchbox + apps grid + NAVIGATE/SELECT/CLOSE hints. `git show --stat cd38c25` — the launcher component files (`LauncherChrome`/`LauncherShell`/`PixelButler`/`LauncherCommandBar`) were NOT modified by the removal.

## R-2 — Theme-preset + per-token override layers unchanged

- [x] R-2: The theme-preset + per-token override layers (`override ?? preset ?? base`) still apply on top of the locked `classic` base. `resetTheme` still clears preset + overrides to the stock `classic` base.
  - Evidence: Tokyo Night preset re-tinted `--accent-primary`→`#7aa2f7` / body bg → `#1a1b26` while `bodyClass:theme-classic`; per-token Body-font override re-tinted `--font-base` while bodyClass stayed classic; "Reset to theme defaults" cleared preset (`""`) + overrides → accent `#9333ea`, font Inter, base classic (ThemeProvider.tsx:194-197 `resetTheme`).

## R-3 — Row-pipeline no regression

- [x] R-3: The RTDB ingest classifier still maps a `fredo emit`/OTLP event onto its row(s) and reaches features via row subscriptions (no row-pipeline regression from the UI removal).
  - Evidence: `fredo emit` chat + tool_use events → classified into `chat_rows` (user_message "e2e-2817: hello from row-pipeline test") and `tool_use_rows` (tool read_file, state init). `telemetry_spans` live (7670 spans, newest 15:59:31).

## R-4 — No fallback / defensive path re-introduced

- [x] R-4: No component re-introduces a fallback extraction path, defensive `??` chain, or multi-path lookup (the removal is UI-only; the classifier/row pipeline is untouched).
  - Evidence: grep across `apps/ui` for the removed identifiers (`DesktopBackground`/`AnimationSelector`/`AnimationContext`/`useAnimation`/`AnimationProvider`/`ThemeSelector`) → zero matches; `Home.tsx`/`ThemeProvider.tsx`/`ThemingSettings.tsx`/`SettingsPanel.tsx` contain no reference back to the deleted animation/base-theme surfaces (no `DesktopBackground` render, no `setTheme`/`availableThemes`). `git show --stat cd38c25` — no classifier/rtdb files touched.

## R-5 — Related-surface overlap

- [x] R-5: Theming surface (`ThemingSettings` — presets, per-token overrides, reset) and legacy SettingsPanel (`AI Model`, `Telemetry` tabs) render correctly after the removal. (The now-empty `Theming` tab is dropped; the remaining tabs persist.)
  - Evidence: Appearance section renders Theme Presets + Accent/Backgrounds/Text/Status/Fonts + Reset (screenshot req3-appearance); `SettingsPanel.tsx` renders only "AI Model" + "Telemetry" tabs (Theming tab dropped); `SettingsPanel.test.tsx` (green) asserts the removed controls render nowhere and the AI Model + Telemetry tabs persist.

## #2819 extension — desktop-light launcher baseline (must-not-change)

> Issue #2819 (desktop launcher matches `desktop-light.png`). These invariants MUST hold
> after the idle/engaged launcher work — any FAIL is a regression. Run alongside the
> #2817 R-1..R-5 baseline.

## R-6 — Window lifecycle unchanged

- [ ] R-6: The own-kernel window-manager contract (#2807) is unchanged: `openWindow` params shape, spawn semantics (`windowStore.ts:68-91`), spread-merge `updateWindow`, idempotent/re-entrancy-guarded `closeWindow`, and the z-order (window stack above the desktop, below the HUD/`StreamStatus`). Opening/closing/launching features behaves; no orphan windows, no occlusion of the freshly opened window by the launcher surface.

## R-7 — Appearance presets (#2811) unchanged

- [ ] R-7: The theme-preset + per-token override layers (`override ?? preset ?? base`) still apply over the locked base; applying a preset re-tints surfaces; a per-token override re-tints; "Reset to theme defaults" restores the base. No theme-cycling / blank / half-render. Preset switching while idle AND while engaged both work.

## R-8 — Token contract intact across the new chrome

- [ ] R-8: No hardcoded hex/`rgba(`/`rgb(` in the changed launcher files (grep gate over `LauncherShell`/`LauncherChrome`/`LauncherCommandBar`/`LauncherAppGrid`/`PixelButler` + any NEW side-tick / dot-grid / rounded-frame component) — zero; no `var(--x)NN` alpha-append (the #2770 round-5 invalid-CSS rule, `colorTint.ts:4-14`); hover/tint via `tint('var(--accent-primary)', N)`; Chakra v3 API only. This re-verifies the AGENTS.md token-first rule across the newly added decorative chrome. (The wireframe's teal `#00d1d1` is the `light-default` preset's token DATA, not a component literal — the grep gate is over component color usage, not preset token definitions.)

## R-9 — Build + test green

- [ ] R-9: `pnpm --filter @fredo/ui build` → zero TypeScript errors; `pnpm --filter @fredo/ui test:run` → green (existing theming/launcher/`SettingsPanel` tests do not regress).

## R-10 — Overlapping launcher surface

- [ ] R-10: The launcher command-bar/grid behavior (`#2808`) is unchanged WHERE the spec does not redesign it: query filter (`filteredEntries`), keyboard nav (↑↓/←→ clamp, no wrap), Enter/Space open, empty-grid no-op (`entryCount === 0`), notch `aria-expanded`, `useWindows()` collapse-on-open, and the #2808 window z-order fix (window above the desktop, below the HUD). **NOTE (redesigned by #2819, NOT an unchanged baseline):** ESC no longer closes the shell / restores focus to the notch (ST-7) — it returns to IDLE and focuses the command bar; the surface is no longer notch-gated (idle = `open=true, engaged=false`). Reference `.opencode/tests/launcher/regression.md` R-1..R-6 + the #2819 launcher extension.
