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
