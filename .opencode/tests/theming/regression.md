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
- [ ] **R-12:** Any token added or remapped by the slice has BOTH a light and dark value and does
      not change any existing consumer's computed color (verify a sample: desktop shell, mission
      monitor node chrome, chat surfaces) before/after. A global token change that shifts an
      unrelated surface is a FAIL.
- [ ] **R-13:** No `var(--x)NN` alpha-append is introduced; transparent tints use `tint()`. The
      chrome's old literals (`rgba(147,51,234,0.12)`, `rgba(255,255,255,0.04)`,
      `rgba(255,255,255,0.12/0.22)`, `rgba(0,0,0,0.6)`, `rgba(0,0,0,0.4)`) are gone. Reference
      F-5/R-7.
