# Theming — Regression

> "Must not change" baseline for the preset feature (Spec #2811). Presets are **additive**;
> they must not regress existing theming behavior. Run on every testing phase that touches the
> theming surface.

## Invariants (must NOT change)

- [ ] **R-1 (base theme record / ThemeMode):** The base `Theme` record and the `ThemeMode` union (`apps/ui/src/app/types/theme.ts:1,89-168`) are unchanged — `themes['turbo']` and `themes['classic']` resolve exactly as before.
- [ ] **R-2 (base-theme CSS-var pass):** The base-theme pass (`ThemeProvider.tsx:59-93`) resolves identically with no preset selected — `Fredo_theme`/`Fredo_theme_overrides` behavior unchanged.
- [ ] **R-3 (per-token override pass):** A single per-token override (accent/background/text/status/font) still wins over a preset and over base (`overrides[key] ?? preset ?? base`), per AC-2. The existing `ColorRow` set (`ThemingSettings.tsx:108-176`) still clears a token via `setOverride(key, '')`.
- [ ] **R-4 (Base Theme toggle):** The existing "Base Theme" `ThemeSelector` (turbo/classic, `ThemingSettings.tsx:226-229`) still functions as a SEPARATE layer from preset selection — switching presets does not reset the base theme toggle, and vice versa.
- [ ] **R-5 (ThemeMode clamp, #2758):** A stale/unexpected `Fredo_theme` storage value still clamps to a literal `ThemeMode` (`ThemeProvider.tsx:47-51`) — the preset feature must not reintroduce an unclamped crash path.
- [ ] **R-6 (raw override + reset affordance):** The "Reset to theme defaults" affordance still only appears when `hasAnyOverride` is true (`ThemingSettings.tsx:189,307`), and its widened contract (clear preset + overrides) does not break the existing per-token-only reset.
- [ ] **R-7 (backend / RTDB / telemetry):** NO backend change — the RTDB row pipeline, `telemetry_spans`/`chat_rows`/`tool_use_rows`/`agent_session_rows`, and every `useEventRows`-backed feature (Mission Monitor, etc.) are untouched and unchanged.
- [ ] **R-8 (window chrome):** Presets do NOT change window chrome (per NFR-4) — the window frame, title bar, and non-UI-chrome surfaces are unchanged.
- [ ] **R-9 (#2842, preset readout is purely additive):** The new live color readout (spec #2842) is READ-ONLY over the theme engine — it must NOT mutate `overrides`, `selectedPreset`, the base-theme pass, or the `override ?? preset ?? base` layering. Selecting a preset / clearing to Default-None / setting a per-token override on top must behave exactly as before the readout existed (F-1..F-9 in functional.md). The readout establishes no new persistence key and writes to no new `localStorage` entry beyond existing `Fredo_theme_preset` / `Fredo_theme_overrides`.
- [ ] **R-10 (#2842, no re-render loop):** Adding the readout must not introduce a state-driven re-render loop — rapidly switching presets / changing an override must not throw "Maximum update depth exceeded" (AGENTS.md #523 pattern). The readout must derive from the existing token/override state (memo/derived), never fire a `setState` inside an effect dependent on a value that changes every render.

## Overlapping suites to run alongside
- `.opencode/tests/mission-monitor/regression.md` — the mission-monitor node/subagent chrome is sourced from base (`--node-bg`, `--edge-gradient`, `--accent-subagent`, `--accent-nested-subagent`), which a light preset does NOT restyle (expected; pending the Architect's open PO question).
- `.opencode/tests/settings/regression.md` — the settings modal shell / `ProfileSettingsModal` is unchanged by this feature (ThemingSettings is already wired into the static Appearance section).

## #2864 extension — token additions must not regress the theme engine

> Issue #2864 may add a global token (e.g. `--hover-bg`). These invariants MUST hold. Run
> alongside R-1..R-10.

- [ ] **R-11:** Existing preset selection, per-token override, and "Reset to theme defaults"
      behave exactly as before (F-1..F-4); the override-wins layering
      (`overrides ?? preset ?? base`) is unchanged. Reference F-1..F-5/R-1..R-6.
- [ ] **R-12:** Any token added or remapped by the slice resolves correctly in BOTH light and dark
      (the T1–T4/T6 derived `color-mix` vars compute from the live preset/override
      `--text-primary`/`--text-secondary`/`--accent-primary` and therefore resolve per theme — NOT
      two separately declared literal values) and does not change any existing consumer's computed
      color (verify a sample: desktop shell, mission monitor node chrome, chat surfaces)
      before/after. A global token change that shifts an unrelated surface is a FAIL.
- [ ] **R-13:** No `var(--x)NN` alpha-append is introduced; transparent tints use `tint()`. The
      chrome's old literals (`rgba(147,51,234,0.12)`, `rgba(255,255,255,0.04)`,
      `rgba(255,255,255,0.12/0.22)`, `rgba(0,0,0,0.6)`, `rgba(0,0,0,0.4)`) are gone. Reference
      F-5/R-7.

### #2864 testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **R-11 PASS (live).** Preset select/reset, per-token accent override set/clear, and `overrides ?? preset ?? base` layering behave as before.
- **R-12 PASS (live).** New derived tokens resolve per theme (`--hover-bg`, `--text-subtle`, `--accent-strong`, `--scrollbar-thumb`); existing consumers unchanged (`--card-hover-bg` #3a3a3a, `--node-bg` #2d2d2d, `--accent-subagent` #6366f1).
- **R-13 PASS (static).** No `var(--x)NN`; the chrome literals (`rgba(147,51,234,0.12)`, `rgba(255,255,255,0.04/0.12/0.22)`, `rgba(0,0,0,0.6/0.4)`) are gone from the audited component files.

---

## #2865 extension — the semantic-token bridge fix must not regress the theme engine

> Issue #2865 may repair the `system.ts` semantic-token bridge (the R3 root cause) or migrate the
> wizard to direct `var(--…)` consumers. Run alongside R-1..R-13. **G-136:** the F-14 "follow-up
> scope" disposition is superseded — the bridge resolving correctly is now required.

- [ ] **R-14 (existing token consumers unchanged):** after the fix, existing consumers of these
      token names (`fg.muted`, `fg.subtle`, `fg.default`, `bg.subtle`, `bg.hover`, `accent.default`,
      `status.*`) still render as before on their surfaces (settings chrome, launcher, desktop
      shell, mission-monitor). A global bridge change that shifts an unrelated surface is a FAIL.
  - **Edge:** compare computed colors before/after on a sample of unrelated surfaces; dark AND light.

- [ ] **R-15 (per-theme resolution + no literal fallback):** any token added/remapped resolves per
      theme (a single derived `color-mix`, not two literal values) and no hardcoded literal is
      introduced as a fallback to work around an unresolved token. Reference F-15/F-16.
  - **Edge:** light + dark + accent override; `var(--x)NN` still absent.

- [ ] **R-16 (build gates + no test weakening):** `pnpm --filter @fredo/ui build` exit 0;
      `pnpm --filter @fredo/ui test:run` green; no existing assertion weakened/disabled/deleted
      (any refreshed assertion owned per G-125). Reference R-9/F-19.

---

## #2868 extension — the theming surface migrates to the Settings app window (G-136)

> Issue #2868 retires `ProfileSettingsModal` and moves the Appearance/theming section into the
> Settings `FredoFeatureClass` window opened from the launcher grid. **G-136:** the overlapping-
> suite note above ("the settings modal shell / `ProfileSettingsModal` is unchanged by this
> feature") is SUPERSEDED — the container is now the Settings window. The theming engine,
> token→var→theme flow, preset/override layering, and Appearance content are unchanged and must
> stay green. Historical records above preserved. Live policy.

- [ ] **R-17 (theming engine + Appearance content unchanged by the container swap):** R-1..R-16
      hold with the Appearance section reached via the Settings window (launcher tile → Appearance):
      preset selection, per-token override, "Reset to theme defaults", the `overrides ?? preset ??
      base` layering, the readout, and light/dark + non-default-accent resolution all behave as
      before; the Settings window chrome (header, nav active bg via `tint()`, borders,
      `--scrollbar-thumb`, Save button) re-tints token-native with the live accent, no stale color,
      text ≥4.5:1 / non-text ≥3:1, and no `var(--x)NN` alpha-append. Reference theming F-1..F-19 +
      `.opencode/tests/settings/` F-40.
  - **Edge:** accent changed while the Settings window is open and a section is mid-edit; a light
    preset + pale accent; the deleted `FloatingSettingsButton` must not orphan any theming consumer
    (e.g. `--hover-bg` consumers).

### #2868 testing round 1 (spec/2868 @ 90da8de) — result

- **R-17 PASS (live).** Appearance reached via the Settings window (launcher tile → Appearance). Dark classic → Light Default re-tints the window chrome (header `rgb(42,42,42)`→`rgb(238,238,238)`; active-nav text `rgb(204,204,204)`→`rgb(12,17,23)`; `--hover-bg` `color-mix(#cccccc 6%)`→`color-mix(#0c1117 6%)`). Pale accent `#7dd3fc` override re-tints the active-nav bg to `color(srgb 0.49 0.827 0.988 / 0.12)` via `tint()` + derived `--accent-strong`; active-nav label vs header contrast **16.33:1**. No `var(--x)NN` alpha-append; the deleted gear left no orphan theming consumer. Evidence: `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.
