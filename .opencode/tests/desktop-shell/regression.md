# desktop-shell — Regression Tests

> "Did we break existing behavior?" — the no-change baseline from the plan's non-goals
> (NFR-A) for issue #2817 (clean desktop shell removal). Run on every testing phase that
> touches the shell launch surface.

## R-1 — Shell chrome unchanged

- [ ] R-1: The launcher / search-or-command bar / online clock / pixel-butler avatar / window system / stream-status behavior is unchanged (no behavior change beyond the removal).

## R-2 — Theme-preset + per-token override layers unchanged

- [ ] R-2: The theme-preset + per-token override layers (`override ?? preset ?? base`) still apply on top of the locked `classic` base. `resetTheme` still clears preset + overrides to the stock `classic` base.

## R-3 — Row-pipeline no regression

- [ ] R-3: The RTDB ingest classifier still maps a `fredo emit`/OTLP event onto its row(s) and reaches features via row subscriptions (no row-pipeline regression from the UI removal).

## R-4 — No fallback / defensive path re-introduced

- [ ] R-4: No component re-introduces a fallback extraction path, defensive `??` chain, or multi-path lookup (the removal is UI-only; the classifier/row pipeline is untouched).

## R-5 — Related-surface overlap

- [ ] R-5: Theming surface (`ThemingSettings` — presets, per-token overrides, reset) and legacy SettingsPanel (`AI Model`, `Telemetry` tabs) render correctly after the removal. (The now-empty `Theming` tab is dropped; the remaining tabs persist.)
