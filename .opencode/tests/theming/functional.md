# Theming — Functional

> Formalizes the `## QA Expert` QA Plan rows from `.opencode/tmp/2811/triage.md` (R1..R5).
> Every case lists the observable expected outcome and required test data.
> **Verification policy: static** — static ACs (R3/R5) pass on `pnpm --filter @fredo/ui build`
> + coverage suite + grep; the "in-a-running-app" ACs (R1/R2/R4) are corroborated live with a
> webview DOM snapshot + screenshot + `localStorage` read (theming emits no telemetry, so no
> `telemetry_spans` query is applicable — do NOT fabricate one).

- [x] **F-1 (AC1 / R-1):** Open Settings → Appearance → Theming. Assert the preset selector lists **exactly** the 18 named presets: Light Default, Dark, Tokyo Night, Solarized, Monochrome, Cyberpunk, Arctic, Deep Space, Dracula, Matrix, Sunset, Coffee, Nord, Synthwave, Terminal Green, Paper, High Contrast, Blueprint. Select **Cyberpunk**, reload the app (Ctrl+R / reopen window).
      **Expected:** 18 distinct named options — no duplicate, none missing, no stale variant. After reload the app re-applies Cyberpunk (active-preset storage reflects "Cyberpunk"; applied CSS vars match it).
      **Edge:** select A → reload → select B → reload must persist B (latest wins). An unknown/leftover preset id in storage must clamp to a known preset (mirror the #2758 ThemeMode clamp), never crash.
- [x] **F-2 (AC2 / R-2):** From a known default base, select **Matrix** (green accent, near-black body). Capture computed CSS vars on `--accent-primary`, `--body-bg`, `--text-primary`, `--status-success`. Then override **accent-primary** via the color picker and re-read.
      **Expected:** switching to Matrix changes accent/backgrounds/text/status immediately (no reload) to Matrix's token values (a computed-style diff vs the base). The overridden token differs from Matrix's value; every other token still equals Matrix's value.
      **Edge:** override-survives-preset-switch semantics must match the agreed precedence (`overrides ?? preset ?? base`, per the Architect) — the override wins. No re-render loop / "Maximum update depth exceeded" on switch. Light-toned presets (Light Default, Solarized, Paper, Sunset) render legible text on their light bg (≥3:1 UI / ≥4.5:1 body, NFR-2).
- [x] **F-3 (AC3 / R-3):** Static. Read each preset definition — assert it is a set of theme-token keys → values (accent/border/body/card/header/text/status + font set) routed through `system.ts` semanticTokens → CSS vars. Run `pnpm --filter @fredo/ui build` + the theming coverage suite. Grep the new/changed preset + component files for raw hex/rgba not routed via a token.
      **Expected:** build green (0 errors/warnings); coverage suite green; no preset injects a raw hex/rgba into a JSX/`style` prop — every preset value is a token value that `ThemeProvider`/`system.ts` maps to a CSS var. A bare hex literal used as a token VALUE (in the data map) is acceptable.
      **Edge:** a preset bypassing the token chain (component `style={{ background: '#fff' }}`, unscoped `backgroundColor: '#...'`) is a FAIL. `var(--x)` references are OK. Preset tokens map to `bg.*`/`fg.*`/`accent.*`/`status.*`/`border.*`.
- [x] **F-4 (AC4 / R-4):** Select **Synthwave**, override one token, then click "Reset to theme defaults". Read computed CSS vars + `localStorage['Fredo_theme_overrides']` (+ `Fredo_theme_preset` if the Architect's model is used). Reload the app.
      **Expected:** after reset, computed CSS vars match the agreed stock (base `ThemeMode` per the Architect, OR `light-default` per UI-UX — **the two planners give DIFFERENT observable outcomes; a single stale default is a FAIL**) and `Fredo_theme_overrides` is empty (`{}` or absent) with the preset id cleared — no residual override. Reload keeps the defaulted (persisted) state and does not resurrect the override.
      **Edge:** reset from a state with NO override (the reset button is hidden when `hasAnyOverride` is false) — verify the affordance only appears with an override active. Reset must clear BOTH the selected preset AND per-token overrides but must NOT reset the `ThemeMode` turbo/classic choice.
- [x] **F-5 (AC5 / R-5):** Static. Grep the new/changed files for the invalid alpha-append pattern `var(--<token>)[0-9a-f]{2}`; confirm any translucent tint/hover uses `tint()`/`color-mix`. Confirm the preset selector + settings use Chakra v3 token/var colors (`bg="bg.surface"`, semantic tokens, `var(--...)`), not raw hex; Chakra v3 prop naming (`disabled`, `loading`, `colorPalette`) honored.
      **Expected:** zero `var(--x)NN` alpha-append occurrences in changed files; translucent tints use `color-mix` via `tint()`; components use token/var colors; Chakra v3 prop naming honored; build green.
      **Edge:** distinguish invalid `var()` alpha-append (FAIL) from a JS-concatenated literal 8-digit hex (`${'#a855f7'}28`, OK). The global CSS `button[data-variant="outline"]` override of `colorPalette` border — a status-colored outline button must render across both tones (prefer `variant="solid"` or verify both).

- [ ] **F-6 (AC1 / #2842 preset readout):** Settings → Appearance → Theming. Select **Cyberpunk**. Assert a grouped color-chip grid renders the preset's accent, background, text, and status token values.
      **Expected:** a bordered panel below the preset selector renders 4 category groups — Accent (`accentPrimary`, `accentSecondary`, `borderColor` — 3 cols), Backgrounds (`bodyBg`, `cardBg`, `headerBg` — 3 cols), Text (`textPrimary`, `textSecondary` — 2 cols), Status (`statusSuccess`, `statusWarning`, `statusError`, `statusInfo` — 4 cols) = 12 chips; **fonts excluded** (color-only). Each chip's swatch `background` equals the applied token value after the preset pass (Cyberpunk: `--accent-primary` = `#ff2bc2`, `--body-bg` = `#0d0221`), and carries a text label + mono hex caption + provenance badge. Verified via DOM snapshot (chips + badges present) + computed-style read + screenshot.
      **Edge:** Default/None shows NO readout (F-8). Switch preset A → B updates chips without reload. Readout reflects only the currently selected preset, and surfaces via BOTH entry points (ProfileSettingsModal + ThemingFeature.renderSettings). Per #2842.
- [ ] **F-7 (AC2 / #2842 changed-vs-base tri-state marking):** With Cyberpunk selected (no override), assert each of the 12 color tokens renders a text provenance badge: `Preset` for tokens the preset's `colors` sets, `Base` for tokens the preset leaves to the locked base theme.
      **Expected:** `changedByPreset = !!preset.colors[key]` drives `Preset`; tokens absent from `preset.colors[key]` render `Base` (muted ghost pill). Each badge is a TEXT label (`"Preset"`/`"Base"`), never color-only. The full 12-token grid renders — Accent (3), Backgrounds (3), Text (2), Status (4). Fonts + non-`ThemeOverrides` tokens (accentSubagent/node/gradient) are NOT rendered. Per #2842.
      **Edge:** all 18 presets set the full 12-color subset, so on them all 12 chips are `Preset`; a `Base` badge appears only for a partial preset or a provider-skipped `''` token. An overridden token flips to `Override` (never `Preset`+`Override` together) per F-9.
- [ ] **F-8 (AC3 / #2842 Default-None clears readout):** Select Cyberpunk (readout appears), then choose "Default / None". Assert the readout is removed and CSS vars revert to the stock `classic` base.
      **Expected:** no preset palette shown; computed `--accent-primary`/`--body-bg`/`--text-primary` match base; `localStorage['Fredo_theme_preset']` = `''`.
      **Edge:** a per-token override present when the preset is cleared is NOT cleared (overridden tokens keep override, others revert to base). Base-theme toggle unaffected. Per #2842.
- [ ] **F-9 (AC4 / #2842 override-wins-over-preset, Override badge):** With Synthwave selected, set accent-primary to `#123456` via the color picker. Assert the accent-primary chip shows `#123456` (NOT Synthwave's raw `#ff6ac1`) AND its badge flips from `Preset` to `Override`.
      **Expected:** readout accent-primary chip = `#123456`; computed `--accent-primary` = `#123456`; `localStorage['Fredo_theme_overrides'].accentPrimary` = `#123456`; text badge reads `Override`; every other non-overridden preset token stays `Preset` with its preset value. Clear the override → the chip flips back to `Preset` and shows the preset value.
      **Edge:** override on a token the preset does not set → chip shows `Override` (value = base + override); `Preset`/`Base` membership unaffected. Override equal to the preset value → still `Override` (`overrides[key] ?? preset ?? base`, layer-membership wins). One badge per chip, never two. Per #2842.
- [ ] **F-10 (AC5 / #2842 token-native + light/dark readable):** Static grep + live. (a) Grep the new readout component for raw hex/rgba injected into a JSX `style`/`backgroundColor` prop — must be zero (token VALUES in the data map are acceptable; the mono hex caption uses `toHex()` purely to format display data). (b) Capture a light preset (**Light Default**, `#f7f8fa` cardBg) and a dark preset (**Dark**, `#151a21` cardBg) screenshot; confirm readout chips + badge labels legible in both (≥4.5:1 on the preset's own `cardBg` surface).
      **Expected:** build green; zero component-injected raw hex; no invalid `var(--x)NN` alpha-append; badge tints via `tint()`/`color-mix`. Light + dark presets render readable label/badge text.
      **Edge:** a color-only chip with no text/badge is a FAIL. High-Contrast / Monochrome must not make labels invisible on their chips. The `LuCheck` icon (if present) is decorative (`aria-hidden`) — the text word carries the state. Per #2842.

## #2864 extension — Settings chrome derives from the theming feature

> Issue #2864 requires every color in the audited Settings surface to derive from the theming
> feature. Rows map to the QA Plan `Q-3..Q-5`, `Q-12` in `.opencode/tmp/2864/triage.md`.
> Live policy — computed-style + contrast probes on a running app (plus static grep).

- [ ] **F-11 (Q-3, Q-4 / AC-2): `--hover-bg` (T1) is derived in the theming feature and resolves per theme.**
      Grep the repo for `var(--hover-bg)` and for its definition (a `color-mix(...)` set via
      `root.style.setProperty` in the `ThemeProvider` base pass). Then read `getComputedStyle` of
      a `--hover-bg` consumer (e.g. a `CompanionSettingsPanel` setting row) live in both themes.
      **Expected:** T1 is a SINGLE derived `color-mix(in srgb, var(--text-primary) 6%, transparent)`
      set once in the theming feature — it computes live from the preset/override vars and so
      resolves per-theme (NOT the `--card-hover-bg` alias, which freezes the classic dark gray on
      light presets, and NOT two separately declared literal values). The live computed background
      is a real color — NOT `rgba(0, 0, 0, 0)`/`transparent` — in BOTH dark and light
      (`≈rgba(255,255,255,0.06)` dark / `≈rgba(12,17,23,0.06)` light). A consumer that computes
      transparent where a surface is intended is a FAIL.
      **Edge:** any global token addition must not alter existing `--card-hover-bg` consumers;
      `system.ts` maps the new token to `bg.hover`.
- [ ] **F-12 (Q-4 / AC-2): Settings chrome re-tints with the live accent.**
      In Settings, switch preset (dark → light → Matrix) and set/clear an `accentPrimary`
      override; read computed styles of the active nav highlight, nav hover, scrollbar thumb,
      dialog border, and the SaveFooter button.
      **Expected:** every accent-linked value changes with the accent and reverts on reset;
      no stale color; the nav highlight is `tint('var(--accent-primary)', …)` or a token (NOT
      `rgba(147, 51, 234, 0.12)`); hover is a token (NOT white-alpha); the scrollbar thumb is
      visible on BOTH themes.
      **Edge:** switch while the modal is open; clear override → revert to preset/base.
- [ ] **F-13 (Q-5 / AC-3): Settings chrome contrast AA (dark + light + non-default accent).**
      Compute contrast for nav labels (active/inactive) vs sidebar bg, section labels/help vs
      surface, scrollbar thumb vs track, and button label vs accent bg.
      **Expected:** text ≥ 4.5:1, non-text UI ≥ 3:1 in every combination. Quote the measured
      ratios; a failing pair is a FAIL naming it.
      **Edge:** light theme + a light preset; the selected-nav label on its tinted highlight.

### Testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **F-11 PASS (live+static).** `--hover-bg` (T1) is a SINGLE derived `color-mix(in srgb, var(--text-primary) 6%, transparent)` set once in the `ThemeProvider` base pass — live computed row backgrounds `color(srgb .8 .8 .8/.06)` dark / `color(srgb .047 .067 .090/.06)` light (NOT `--card-hover-bg` #3a3a3a, NOT transparent). `system.ts` maps `bg.hover` → `var(--hover-bg)`.
- **F-12 PASS (live).** Active-nav bg re-tints purple→cyan→amber with the live accent; left border = `--accent-strong`; scrollbar thumb = `--scrollbar-thumb`; Save button foreground `--accent-contrast` (white dark 5.38:1 / #0c1117 light 9.96:1).
- **F-13 PASS with named residuals (live).** All measured pairs meet AA except two pre-existing/untouched residuals: inactive-nav label on the dark header **4.05:1** and not-ready-gate dark card body/path text **1.53:1** (R3). Both recorded accepted-with-reason in the verdict.

## F-14 (promoted from exploratory E-12 / #2864) — Chakra semantic-token bridge resolves to Fredo vars

- [ ] **F-14:** Read `getComputedStyle(document.documentElement)` and assert the `system.ts` semantic-token
      CSS vars resolve to the Fredo theme vars, not stock Chakra values: `--chakra-colors-fg-muted` →
      `var(--text-secondary)`, `--chakra-colors-fg-subtle` → `var(--text-subtle)`,
      `--chakra-colors-bg-hover` → `var(--hover-bg)`, `--chakra-colors-fg-onAccent` → `var(--accent-contrast)`.
  **Expected:** each semantic token resolves to the mapped Fredo var (or its computed value), so token-name
      consumers in the audited files inherit the live theme. **Observed (spec/2864 @ 5c0fb5b):**
      `--chakra-colors-fg-muted` = `#52525b` (stock `gray.600`) and `--chakra-colors-fg-subtle` = `#a1a1aa`
      (stock `gray.400`); `--chakra-colors-fg-default`/`bg-hover`/`fg-onAccent`/`accent-solid` empty. This
      makes the not-ready-gate dark card body/path text 1.53:1 (residual R3). Pre-existing; follow-up scope.
  - **Edge:** a component that uses a token NAME (`color="fg.muted"`) instead of `var(--text-secondary)` is
    the failure surface; `var(...)`-direct consumers are unaffected. Reference exploratory E-12.

---

## #2865 extension — semantic-token bridge must resolve (R3 residual now IN SCOPE)

> Issue #2865 requires the not-ready wizard's colors to derive from the theming feature. Rows map to
> the QA Plan `R-3.1/R-3.2/R-3.3/R-3.5` + `R-5.3` in `.opencode/tmp/2865/triage.md`.
> **G-136 reconciliation:** F-14's closing phrase "Pre-existing; follow-up scope." is SUPERSEDED for
> this spec — the backlog brings the R3 residual in scope, so the semantic-token bridge resolving
> correctly is now a required outcome, not a follow-up. The historical F-14 record is preserved.
> **Verification policy: live** — the bridge is only provable by reading computed styles on the
> running app (plus the static literal grep).

- [ ] **F-15 (R-3.2 / AC3):** On the running app read
      `getComputedStyle(document.documentElement)` and assert the `system.ts` semantic-token CSS vars
      resolve to the Fredo vars: `--chakra-colors-fg-muted` → `var(--text-secondary)`,
      `--chakra-colors-fg-subtle` → `var(--text-subtle)`, `--chakra-colors-bg-hover` →
      `var(--hover-bg)`, `--chakra-colors-fg-on-accent` → `var(--accent-contrast)`, and
      `--chakra-colors-fg-default` resolves (not empty). Then measure the wizard card body/path text
      vs its tinted card in dark + light + accent.
  **Expected:** each semantic token resolves to the mapped Fredo var (or its computed value) — NO
      stock-Chakra fallback (`fg.muted` ≠ `#52525b`, `fg.subtle` ≠ `#a1a1aa`), NO empty token; the
      wizard card text ≥4.5:1 (or ≥3:1 large/bold) in every combination; the BEFORE dark 1.53:1
      (`rgb(82,82,91)` on `rgb(42,59,53)`, 12px) is RESOLVED and the AFTER ratio reported. A token
      still resolving to stock/empty, or a pair < AA = FAIL naming it.
  - **Edge:** either fix is acceptable — repair the bridge OR migrate the wizard to direct
    `var(--text-secondary)` — but a literal fallback introduced to mask it is a FAIL (F-16).

- [ ] **F-16 (R-3.1 / AC3):** Static grep the audited wizard files (`CompanionSetupWizard.tsx`,
      `SetupStepCard.tsx`, `ModelFilesStepCard.tsx`, `ServerLaunchStepCard.tsx`) + the slice diff for
      hex/rgba/rgb/hsla and the invalid `var(--x)NN` alpha-append.
  **Expected:** ZERO true color literals (comment issue-refs exempt); theme token → CSS var +
      `tint()` only; no literal fallback introduced to work around a broken semantic token. Any
      literal = FAIL naming file:line.
  - **Edge:** `transparent`/`inherit`/`currentColor`/`none` allowed; distinguish `var(--x)NN` from a
    JS 8-digit hex concat.

- [ ] **F-17 (R-3.3/R-3.5 / AC3, H1/H8/G-137):** From live computed colors, measure the wizard's
      retry/error affordances and the accent-linked surfaces (running card, install button) in dark
      + light + a non-default accent; specifically an accent-filled control thumb vs its accent
      track.
  **Expected:** retry/error text ≥4.5:1, non-text UI ≥3:1, all combinations; every accent-linked
      surface re-tints with no stale color; the thumb contrasts its accent track ≥3:1 (G-137). Quote
      the measured ratios; a failing pair = FAIL naming it.
  - **Edge:** a light/desaturated accent keeps the on-accent label ≥4.5:1; the error card border vs
    its fill ≥3:1.

- [ ] **F-18 (R-2.4 / AC2):** Switch theme/accent with the wizard open in checking/missing/running/
      error/installed; confirm no `Maximum update depth exceeded` and every state re-tints live.
  **Expected:** no stale color, no console error; status remains icon+text after the re-tint.
  - **Edge:** switch mid-download/mid-error; switch at the gate (not-ready).

- [ ] **F-19 (R-5.3 / AC5):** Any token added/remapped by the slice resolves correctly in BOTH light
      and dark and does not shift an unrelated surface (desktop shell, mission-monitor node chrome,
      chat surfaces); `pnpm --filter @fredo/ui build` + `pnpm --filter @fredo/ui test:run`.
  **Expected:** per-theme resolution (a single derived `color-mix`, not two literal values); existing
      consumers unchanged; build exit 0; suite green. Reference R-11..R-13.
  - **Edge:** clear the accent override → revert; `var(--x)NN` still absent.
