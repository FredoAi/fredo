# Theme Contract — Functional

> Formalizes the `## QA Expert` QA Plan rows `Q-1..Q-12` from `.opencode/tmp/3034/triage.md`
> (AC1..AC5 + NF). Feature #3034: one documented + machine-readable theme contract that every
> surface/state derives from, so no component makes a local colour decision. The sibling gate
> (#3033, `.opencode/tests/contrast-gate/`) is MERGED — #3034 makes the gate CONSUME the contract
> and must not regress it. The specific defect sweep is sibling #3035.
>
> **Verification policy: live** — theme rendering is a UI surface: the ACs are proven by a running
> artifact (DOM snapshot / computed CSS vars / before-after screenshots) PLUS the contract's
> machine-readable enumeration and the gate command
> `pnpm --filter @fredo/ui contrast:gate` (vitest over `apps/ui/src/app/theme/contrast`).
> A static-only PASS for the live rows (F-5, F-7) is a **false PASS**.

## Contract completeness (AC1)

- [ ] **F-1 (Q-1 / AC1):** Import the contract module and assert it enumerates every semantic token
      (`bg.*`, `fg.*`, `border.*`, `accent.*`, `status.*` — `apps/ui/src/app/theme/system.ts:56-136`)
      AND every interactive state (`default|hover|focus|disabled|selected` — `matrix.ts:38`) AND every
      shipped preset (`PRESET_IDS` = `classic (base — no preset)` + the 18 built-ins — `matrix.ts:96-111`).
      Assert `buildContrastMatrix()`'s preset/surface/state/pair set is **set-equal** to the contract's
      enumeration (one source; no second literal list).
      **Expected:** gate (`pnpm --filter @fredo/ui contrast:gate`) exits 0; the contract is the single
      machine-readable enumeration and the matrix derives from it.
      **Edge:** `classic (base — no preset)` present and distinct from the 18 preset rows; `themes.turbo`
      absent (base locked to `classic`, `matrix.ts:103`); a declared state with no backed token = FAIL.

- [ ] **F-2 (Q-2 / AC1):** For every `(preset ∈ PRESET_IDS, token, state)` resolve the value and assert
      it parses as a colour — never `undefined`/empty (`resolvePresetToken` = `preset ?? classic base`,
      `matrix.ts:114`; `mustParse` throws otherwise, `matrix.ts:170`).
      **Expected:** zero unresolved/empty tokens for ANY state in ANY preset, incl. the no-preset base
      and every light preset.
      **Edge:** base `classic`; light presets (`light-default`, `solarized`, `arctic`, `sunset`, `paper`);
      a preset that omits a token resolves to base via layering — never `undefined`.

## Raw-colour audit (AC2)

- [ ] **F-3 (Q-3 / AC2):**
      `evaluateRawColors(scanRawColors(defaultScanTargets()), RAW_COLOR_ALLOWLIST, RAW_COLOR_BASELINE,
      RAW_COLOR_BASELINE_MAX)` ⇒ `violations.length === 0` AND `staleBaseline.length === 0` AND
      `RAW_COLOR_BASELINE.length === RAW_COLOR_BASELINE_MAX` (ratchet-down only). Every
      `RAW_COLOR_ALLOWLIST` entry is a named data/art kind (`terminal-ansi|canvas-3d|node-identity|
      test-fixture`, `rawColorAllowlist.ts:24`) and literal-pinned.
      **Expected:** coverage spans `apps/ui/src/applications/**` + `system.ts`; **two-tier (G-235)** —
      absolute zero once #3035 lands; until then no-worse-than the capped #3035 baseline (128 raw hits,
      `rawColorBaseline.ts:23-27`); gate exits 0.
      **Edge:** `apps/ui/src/shared/**` OUT of scope day one (do NOT assert coverage there);
      **anti-widening** — an allowlisted file licenses ONLY its pinned literals
      (`normalizeRawLiteral`); UI-chrome files (`DevMode.tsx`, `OptimizelyFlagsPanel.tsx`,
      `NodeContextMenu.tsx`, `FocusWindow.tsx`) are NEVER allowlistable.

- [ ] **F-4 (Q-4 / AC2, G-361 negative proof):**
      `evaluateRawColors(scanRawColors([{ path: 'apps/ui/src/applications/__injected__/Bad.tsx',
      source: 'const c = "#ff0000";' }]), RAW_COLOR_ALLOWLIST, RAW_COLOR_BASELINE,
      RAW_COLOR_BASELINE_MAX)` ⇒ `violations` contains `#ff0000`.
      **Expected:** the injected unbaselined UI-chrome literal is a NEW violation ⇒ the gate FAILS
      (per-dimension negative proof; deterministic in-repo input).
      **Edge:** `kind: 'var-alpha-append'` (`var(--x)55`) also fails; positive control (pinned allowlist
      literal in the allowlisted file) yields zero.

## Contract drives every surface / state (AC3)

- [ ] **F-5 (Q-5 / AC3, before→after G-223 — LIVE):** Capture a before-baseline (one preset). Open
      Settings → Appearance → Theming; switch preset via `ThemePresetSelector`
      (`apps/ui/src/applications/theming/components/ThemingSettings.tsx:82`, `aria-label="Theme presets"`)
      to a light preset (**Light Default**) AND set a distinct accent via the accent `input type=color`
      (`ThemingSettings.tsx:155`, label `Primary` → `accentPrimary`). Read computed `--body-bg`,
      `--card-bg`, `--header-bg`, `--accent-primary`, `--border-color`, `--text-primary`; screenshot
      before/after. Assert every surface (canvas/card/header) AND every control class (outline button,
      select, radio card, disabled/selected) re-tints; assert the diff touches ONLY the theming token
      definitions (`apps/ui/src/app/types/theme.ts` / the contract module) — zero component edits.
      **Expected:** all surfaces/states change from ONE token-def change; no component-local edit;
      demonstrated incl. ≥1 light preset.
      **Edge:** `Default / None` (no-preset base, option value `""`) leg; every preset in `PRESET_IDS`;
      preset + accent combined; the change survives reload (`Fredo_theme_preset` /
      `Fredo_theme_overrides`).

## Control classes + states (AC4)

- [ ] **F-6 (Q-6 / AC4):** Assert the matrix contains rows for `control-outline`, `select`, `radio-card`
      incl. `disabled` + `selected` for ALL 19 presets; each ratio ≥ its floor OR baselined to #3035
      (two-tier, G-235); scan/grep those components for any component-local colour override (raw literal
      or non-contract token) ⇒ zero.
      **Expected:** the evidenced-defect classes are legible (≥ floor, or baselined) in every preset
      incl. light; NO component-specific colour override.
      **Edge:** `disabled` composed opacity (select 0.5 / radio-card 0.55 / outline 0.5) and `selected`
      tint 0.12 are explicit composed pairs (H1, `matrix.ts:133-142`); `RadioCard.ItemIndicator` stock
      palette = `KNOWN_OUT_OF_SCOPE_PAIRS` → #3035 (`matrix.ts:85-93`); sub-floor control → the
      "no-worse-than-control" tier governs (G-235).

- [ ] **F-7 (Q-7 / AC4 — LIVE):** Render each control class in a light preset, the dark base, and the
      no-preset base; capture and assert label/border/ring are visibly legible (not washed out).
      **Expected:** no control class is illegible in any preset (≥ floor, or no-worse-than-control by
      declared tolerance).
      **Edge:** light presets whose pre-change control is already below AA → tier
      "no-worse-than-control"; disabled/selected forced via the shipped props.

## A new control cannot violate AA (AC5)

- [ ] **F-8 (Q-8 / AC5):** Add a control using ONLY contract tokens/states (no raw colours, no local
      overrides); run the gate; assert the new control's state pairs appear in the matrix (derived from
      the contract) and clear the floor OR are baselined.
      **Expected:** gate exits 0; the new control's states are contract-derived and AA-safe.
      **Edge:** a new state NOT declared in the contract ⇒ FAIL (completeness, ties to F-1).

- [ ] **F-9 (Q-9 / AC5, G-361 negative proof):**
      `evaluateContrast([...buildContrastMatrix(), injectedRow(key fresh, ratio 1.2)], CONTRAST_BASELINE,
      BASELINE_MAX)` ⇒ `violations` contains the injected key. Together with F-4, both audited dimensions
      fail closed.
      **Expected:** per-dimension negative proof — an injected below-floor pair FAILS the matrix gate;
      an injected raw literal FAILS the raw gate.
      **Edge:** injected key equal to a baselined key ⇒ baselined, NOT new (key identity);
      `ratio === floor` exactly ⇒ pass (boundary); just below floor ⇒ violation.

- [ ] **F-10 (Q-10 / AC5 — contract consumption):** Mutate ONE token definition in the contract/theming
      token source; assert BOTH `buildContrastMatrix()` row ratios change AND the rendered CSS var
      changes; assert the matrix enumeration equals the contract enumeration. (`matrix.ts:105-108`
      currently imports `themes`/`themePresets` directly — the contract must become that single source.)
      **Expected:** a single source — the gate AND every surface derive from the contract; a divergent
      copy = FAIL.
      **Edge:** a mutated token that flips a pair below floor ⇒ the gate FAILS (proves it consumes the
      change); reverting restores green.

## Non-functional

- [ ] **F-11 (Q-11 / G-236):** For `--accent-strong` (accent 55% / `textPrimary` 45%) and
      `--text-subtle` (`textSecondary` 65% / `textPrimary` 35%) assert the mix target luminance is
      mid-range (neither endpoint-dominant) per `matrix.ts:120-125`.
      **Expected:** derived tokens stay mid-luminance; no endpoint collapse.
      **Edge:** pale accent / dark text; every preset.

- [ ] **F-12 (Q-12 / NF):** `pnpm --filter @fredo/ui build` exit 0 (zero TS errors);
      `pnpm --filter @fredo/ui test:run` green incl. the gate; gate < ~5 s; read-only
      (`git status --porcelain` clean after the gate run); no new dependency; `git diff` limited to the
      contract + theming token definitions + gate wiring.
      **Expected:** all green; bounded; read-only.
      **Edge:** no existing assertion weakened; `contrastGate.negative.test.ts` (both dimensions) still
      passes; `globalFocusVisible.test.ts` unweakened.
