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

---

## #2899 extension — theme-colored procedural desktop backgrounds (Appearance)

> Issue #2899 adds a background chooser to Settings → Appearance: **None** (default = today's
> desktop) plus ≥5 procedural backgrounds driven by the active theme. Rows map to the QA Plan
> `REQ-1..REQ-6`, `F-20..F-27` in `.opencode/tmp/2899/triage.md`.
> **Verification policy: live** — DOM/computed-style/`elementFromPoint`/screenshot reads on the
> running app; the mandatory live receipt is F-26 (`telemetry_spans` + raw screenshot URLs).
> **G-136 (host note):** the Appearance host is the Settings feature window
> (`apps/ui/src/features/settings-app/...` → the Appearance section), not the retired modal.
> **G-170:** the "never covers/intercepts" rows assert a present, measured element at its resting
> rect. **Animation is out of scope** (no animated descriptor ships), so no non-identity-transform
> frame leg applies; assert instead that the slice introduces no `@keyframes`/continuous animation.
> **G-136 SUPERSEDED (#2905):** the static-only animation scope on this line, and the
> "no `@keyframes`/continuous animation" clauses in F-22/F-24/F-25, are SUPERSEDED by the
> `#2905 extension` below — animated built-ins are now REQUIRED. Historical rows preserved.

- [x] **F-20 (REQ-1 / AC1):** Open Settings → Appearance → Background. DOM-snapshot + screenshot the
      selector; on a fresh profile read the default; select each option then **None**; compare the
      None desktop against a BEFORE capture of the pre-slice tip.
  **Expected:** selector offers **None + ≥5 named procedural backgrounds, pairwise visibly distinct**
      (no duplicate/missing). Fresh profile selects **None**. With **None** active the desktop is
      **visually identical to today** (BEFORE/AFTER pixel-comparable; no added background-node paint,
      `elementFromPoint` over the desktop returns the shell, not a background element). Each non-None
      option renders a distinct paint signature.
  - **Edge:** re-select the active option (idempotent); rapid A→B→C cycling with console clean;
    upgraded profile vs fresh; None after a non-None (full revert).

- [x] **F-21 (REQ-2 / AC2):** With a background active, switch preset (one **light-based** e.g. Light
      Default, one **dark-based** e.g. Dark/classic), change the accent, and edit a per-token color;
      read the background element's computed paint + sampled colors before/after each change.
  **Expected:** every background **recolors live with no restart** and derives its paint from the
      **active theme tokens** (computed paint differs when the theme changes; no hardcoded color
      survives a switch). Renders correctly for a light-based **and** a dark-based preset — visible,
      non-clashing, foreground legible.
  - **Edge:** theme switch with the selector open; accent override set then cleared; override of a
    token the background does not use (must not shift); rapid churn; console clean of
    `Maximum update depth exceeded`.

- [x] **F-22 (REQ-6 / complex Gherkin):** Given a non-None background selected, **when** switching to
      a different preset **including a light-based preset**, **then** the rendered background recolors
      to the new theme's colors without a restart, **and** shell chrome + window content on top remain
      legible — screenshot + computed paint before/after, legibility measured on the post-switch frame.
  **Expected:** the full Given/When/Then holds end-to-end (same live mechanism as F-21, asserted as
      one scenario): recolor is live (no reload/restart), and the post-switch frame keeps chrome +
      content legible. Animation is **out of scope** (all six descriptors ship static) — assert no
      `@keyframes`/continuous animation is introduced, so chrome/window separation holds on the
      post-switch frame. **[G-136 SUPERSEDED (#2905): the "no animation" clause is superseded —
      animated built-ins are required; see F-32/F-33. The recolor + post-switch legibility intent
      stands.]**
  - **Edge:** dark→light and light→dark; light preset captured on the post-switch frame; switch with
    a window maximized (chrome + content both in frame).

- [x] **F-23 (REQ-3 / AC3):** Select a non-None background; read the persisted value (`localStorage` +
      AppStore `get_setting`); **cold-restart** the app; re-open Appearance and screenshot the desktop.
      Repeat for **None**, then inject a stale/unknown stored value and restart.
  **Expected:** selection persists across a **full app restart** and restores **exactly** (same option
      active, same rendered paint). **None persists and restores as None** (today's desktop). A
      stale/unknown value (`'__nope__'`, `''`, `null`, a removed id) falls back **safely to None** — no
      crash, no blank/broken background, no console error.
  - **Edge:** restart right after a selection change; value seeded before first boot; absent key vs
    present-but-empty; value written by an older build.

- [x] **F-24 (REQ-4 / AC4):** With each background active (all six ship **static** — animation is out
      of scope **[G-136 SUPERSEDED (#2905): animated built-ins are now required — contrast must be
      measured on the ANIMATED render; see F-30/F-34. The legibility + no-window-intercept intent
      stands]**), measure contrast of shell chrome text (command bar, side ticks, clock, tiles) and
      window content vs their surfaces; `elementFromPoint` at points inside a maximized and a floating
      window; read stacking/z-order; click + type into a window while the background is active.
  **Expected:** shell chrome and window content stay **legible** (body text ≥4.5:1, large/bold ≥3:1,
      non-text UI ≥3:1) on both light- and dark-based presets. **No background renders above a
      window** — `elementFromPoint` inside the window resting rect returns window/desktop-shell
      content, never a background node. The background **intercepts no pointer/keyboard input**
      (clicks land, typed text reaches the focused field).
  - **Edge:** maximized / floating / minimized windows; window dragged over the background; light
    preset + pale accent worst case; window open/closed across a selection change; two windows.

- [x] **F-25 (REQ-5 / AC5):** (static) grep the slice for raster background art and color literals;
      (live) inspect the background DOM (procedural node/CSS/canvas — no `<img>`/raster `url(...)`),
      sample frame timing + process CPU idle and during interaction, and toggle
      **`prefers-reduced-motion: reduce`**.
  **Expected:** backgrounds are **procedural only** — zero uploaded/bundled raster, **zero hardcoded
      colors** (all paint from theme values; comment issue-refs exempt). **No animated descriptor
      ships** (static-only scope) **[G-136 SUPERSEDED (#2905): animated built-ins are REQUIRED; the
      "zero @keyframes/rAF" assertion is inverted to "animation is present AND gated under
      `prefers-reduced-motion: reduce`" — see F-32/F-34/F-35]**: no `@keyframes`/continuous
      animation/rAF/interval in the slice; the
      only motion is the selection crossfade, which snaps to **0 ms** under
      `prefers-reduced-motion: reduce` and never flashes/strobes. App stays responsive: no perceptible
      launch/interaction degradation, CPU/GPU bounded and non-growing over a sustained idle window.
  - **Edge:** reduced-motion toggled live (crossfade → 0 ms); sustained idle soak (no growth);
    build + suite gates; `var(--x)NN` absent; no `@keyframes` present.

- [x] **F-26 (REQ-LIVE / NF):** During the F-20..F-25 run: `fredo emit --event-type chat
      --session-id e2e-2899-chat` + `--event-type tool_use --session-id e2e-2899-tool --tool-name
      read_file`; query `telemetry_spans` + `chat_rows`/`tool_use_rows` (telemetry-query skill);
      retain screenshot raw URLs + live `tauri_webview_*` receipts.
  **Expected:** `telemetry_spans` **NON-ZERO** with a recent `max(ingested_at)`; both markers
      classify; each live row carries rendered-webview receipts. **A static-only PASS is a FALSE
      PASS.**
  - **Edge:** re-run on the tested tip; keep emit + query output verbatim in `## Tests Runs`; do not
    fabricate a span query.

- [x] **F-27 (REQ-NF):** `pnpm --filter @fredo/ui build`; `pnpm --filter @fredo/ui test:run`; run the
      theming + settings + desktop-shell regression suites.
  **Expected:** build exit 0, zero TS errors/warnings; suites green; existing assertions **not
      weakened/disabled/deleted** (refreshed assertions owned per G-125).
  - **Edge:** no dangling import; no stale literal test; overlap suites green.

### #2899 testing round 1 (spec/2899 @ c846e2e7) — results

- **F-20 PASS (live).** `desktop-background-chooser` radiogroup, 7 tiles (None default `aria-checked=true data-selected=true tabindex=0`); all previews pairwise distinct; None → zero `desktop-backdrop` DOM and the launcher surface back to `rgb(45,45,45)` + 28px grid (pre-slice `DESKTOP_TEXTURE_CSS` byte-identical).
- **F-21 PASS (live).** Deep Space→Light Default recolor: backdrop paint `rgb(10,14,26)`+blue/purple → `rgb(255,255,255)`+cyan, no restart; accent `#123456` re-tinted the first bloom live; an unused-token override (`cardBg`) left the paint unchanged.
- **F-22 PASS (live).** Post-switch light frame: chrome 8.58:1 / window title 8.94:1 legible; no `@keyframes`/animation introduced.
- **F-23 PASS (live).** `mesh` and `none` round-tripped a cold restart (`dev-env.ps1 -Action Restart`); AppStore `settings` read-back `mesh`; injected `banana` → None fallback, no crash, console clean.
- **F-24 PASS (live, G-170).** Floating 480×320 window: `elementFromPoint` returns window content, backdrop z=0 `pointer-events:none`; typed input reached the focused field; ratios identical with None vs aurora. Disclosed residual: `--text-secondary`/`--card-bg` 3.89:1 captions (pre-existing, DockPosition measures the same).
- **F-25 PASS (live+static).** Empty backdrop div, no raster, zero literals/rAF/`@keyframes`; 16.5 ms avg frame / flat heap. Reduced-motion OS toggle not emulable via the Tauri MCP driver — non-blocking: zero animation ships.
- **F-26 PASS (live).** `telemetry_spans` 15680, `max(ingested_at) 2026-09-19T13:16:33Z`; `chat_rows` 49057 (`user_message` extracted) + `tool_use_rows` 63247/63296 classified.
- **F-27 PASS.** Build exit 0 (`✓ 2576 modules`); `test:run` 107 files / 1732 tests passed, 0 failed.

---

## #2905 extension — visibly applied + animated procedural backgrounds

> Issue #2905 is a **bug + enhancement revising #2899**: the chosen procedural background must be
> **visibly applied behind the windows** (AC1), read clearly on dark + light incl. the reporter's
> dark/brown palette (AC2), be **animated** with living/generative motion while each option stays
> distinct (AC3), honor OS reduced-motion and never flash/strobe (AC4), stay CPU/GPU-bounded with
> **None restoring today's clean desktop** (AC5). Rows map to the QA Plan `Q-1..Q-11`
> (the Architect's **`R-1..R-5`** sub-clauses + live/NF) in `.opencode/tmp/2905/triage.md`.
> Contract hooks bound here: `data-motion`, `data-background-id`,
> `[data-testid="desktop-backdrop-motion-styles"]`, `[data-background-layer]`, and the chooser
> caption `[data-testid="desktop-background-motion-status"]`; constants `MOTION_LAYERS_MAX=3`,
> `MOTION_DURATION_MIN_MS=8000`, `MOTION_OPACITY_MIN=0.35`; pure `resolveBackgroundMotion` +
> `isBoundedMotion`.
>
> **G-136 SUPERSESSION (mandatory):** the `#2899 extension` above (and its rows F-22/F-24/F-25)
> asserted animation was **out of scope** and that the slice introduces **no** `@keyframes`/
> continuous animation. **#2905 inverts that scope** — animated built-ins are now REQUIRED. Those
> static-only assertions are marked `G-136 SUPERSEDED (#2905)` in place (rows preserved); the
> tester must NOT execute them as written. The product invariant test
> `background.invariants.test.tsx` leg (d) ("no continuous animation") is likewise superseded and
> must be inverted to gate animation under reduced motion.
>
> **AC1 is rendered-pixel based.** #2899 passed AC1 by reading the backdrop element's computed
> `background-image` while the user reports the background is not visible at all. A computed-style
> read is **explicitly insufficient** here — F-28/F-29 sample the rendered pixels so a
> correctly-painted-but-occluded element cannot pass.
>
> **Verification policy: live.** F-37 carries the mandatory `telemetry_spans` receipt; F-38 the gates.
> **Contract names (G-187):** `[data-testid="desktop-backdrop"]`,
> `[data-testid="desktop-background-chooser"]`, `[data-testid="desktop-background-option-{none,aurora,nebula,mesh,topography,constellation,halo}"]`,
> key `Fredo_desktop_background`.

- [x] **F-28 (Q-1 / R-1.1, R-1.2, AC1):** Open Settings → Appearance → Desktop Background
      (`[data-testid="desktop-background-chooser"]`). For **None**, **Aurora**, **Nebula** (≥2
      procedural): select the option, screenshot the desktop, then sample the **rendered pixels** at
      a fixed set of ≥5 desktop points (top-left quadrant, top-right quadrant, centre, lower-left,
      lower-right — inside the desktop region, NOT inside any window resting rect). Report sampled
      RGB per option. Repeat with **Mesh**; then select `None`.
  **Expected:** sampled pixels differ **per procedural option**, each differing from the **None**
      control at **≥3 of 5** points (per-channel Δ ≥ 8 or ΔE ≥ 2); procedural options pairwise
      distinct. A non-empty computed `backgroundImage` whose sampled pixels equal the None control is
      an explicit **FAIL**.
  - **Edge:** all 6 procedural options (pairwise distinct); window over a sample point (re-sample
    outside its resting rect, G-170/G-171); maximized window; launcher strip displayed vs hidden.

- [x] **F-29 (Q-2 / R-1.1, R-1.3, AC1):** With a procedural option active, read the backdrop's
      `getBoundingClientRect()` + effective stacking, then `document.elementFromPoint(x,y)` at the
      F-28 points and compare each painted pixel against the None control.
  **Expected:** ≥1 desktop point shows the backdrop's paint (differs from None) — the background is
      actually **visible**, not merely present in the DOM. If every sampled point equals the None
      control → **FAIL** naming the covering layer (report `elementFromPoint` tag/testid per point).
      `elementFromPoint` returning the transparent shell is acceptable; the **pixel** comparison is
      authoritative.
  - **Edge:** **Architect root cause (R-1.1):** the always-mounted `LauncherShell` fixed surface at
    `SURFACE_Z_VISIBLE=1100` (`LauncherShell.tsx:817-820`) was filled
    `tint('var(--body-bg)', 72)` — a 72%-opaque full-viewport veil above the z=0 backdrop, diluting
    each option to ≈3–7% net. F-29 MUST FAIL on that pre-fix state and PASS only after the
    non-`none` fill is `transparent` (or ≤ `tint(...,20)`); name `LauncherShell.tsx:817-820` as the
    occluder in the evidence. Other edges: desktop region vs launcher strip; window dragged across
    all samples; dark + light.

- [x] **F-30 (Q-3 / R-2.2, AC2):** With a procedural background active, measure contrast for
      (a) shell chrome text (command bar, clock, tiles) vs its effective backdrop and (b) window
      title/body content vs the window surface, on **Dark/classic**, the **reporter's dark/brown
      palette** (record the exact preset id — e.g. Coffee/Sunset), and a **light** preset
      (Light Default). Compute ratios from sampled/composited colors.
  **Expected:** body text **≥4.5:1**, large/bold **≥3:1**, non-text UI (borders, tiles, ticks)
      **≥3:1** on every combination. Quote every measured ratio; a pair below threshold = **FAIL**
      naming it. Window-content contrast is background-invariant (windows keep their opaque surface).
  - **Edge:** reporter's exact dark/brown preset (state which); pale accent + light worst case;
    accent override set/cleared live; window over the busiest background region.

- [x] **F-31 (Q-4 / R-2.1):** With a procedural background active, switch dark→light and
      set/clear an `accentPrimary` override; sample rendered pixels before/after each change; also
      override an unused token (`cardBg`).
  **Expected:** pixels change **live with no restart** and derive from live theme tokens; the unused
      override leaves paint unchanged; no hardcoded color survives a switch (static grep corroborates:
      zero hex/rgb/hsl in the background module).
  - **Edge:** rapid churn; theme switch with the chooser open; token the recipe does not consume.

- [x] **F-32 (Q-5 / R-3.1, AC3):** **FIRST** read
      `window.matchMedia('(prefers-reduced-motion: reduce)').matches` via `tauri_webview_execute_js`
      and record the raw value. If `false`: immediately after selecting a procedural option capture
      **t0**, then take **3–5 SHORT SYNCHRONOUS samples ~150–300 ms apart** (NO `setTimeout`/async —
      a delayed sampling call times out in the Tauri webview) of the backdrop's computed paint
      (`background-position`/`transform`/`opacity`) and read
      `document.querySelector('[data-testid="desktop-backdrop"]')?.getAnimations()`.
  **Expected:** `reduce:false` → **≥2 distinct intermediate frames** across consecutive samples AND
      `getAnimations()` returns ≥1 `running` animation with non-zero duration, AND the backdrop's
      `data-motion` attribute reads `animated` (Architect DOM contract). `reduce:true` → a **static** render is
      CORRECT; do NOT require intermediate frames — `data-motion` reads `static` and the motion
      caption (`[data-testid="desktop-background-motion-status"]`) reads
      `Motion: off (system reduced motion)`. Record the flag verbatim; a single sample or a delayed
      async read is insufficient evidence.
  - **Edge:** capture immediately after the trigger; two different options (distinct motion); theme
    switch mid-animation; drag during animation.

- [x] **F-33 (Q-6 / R-3.3, AC3):** Read `getAnimations()` (animation-name + duration/timing) and/or
      each animated element's computed animation properties for all 6 procedural options.
  **Expected:** each animated descriptor's motion is **visibly distinct** per the Architect's
      per-option identity table (aurora = 2 veils drifting apart; nebula = breathing cloud + grain
      twinkle; mesh = 3 independent currents; topography = contour expand; constellation = night-sky
      twinkle + breathe; halo = breathing halo) — a distinct `@keyframes` kind/duration/delay/easing
      signature; no two options share an identical animation signature. `data-background-id` confirms
      the applied descriptor; each animated option renders its declared `[data-background-layer]`
      children (≤ `MOTION_LAYERS_MAX` = 3). Any intentionally-static layer is recorded as such.
  - **Edge:** all 6 options; reduced-motion on (all static); re-select the same option (idempotent
    signature).

- [x] **F-34 (Q-7 / R-4.1, R-4.2, R-4.3, AC4):** (a) **Product-unit/static pin (G-050/#2870):** a unit/static test
      asserts the animated descriptors are **suppressed/gated** under reduced motion: the pure
      `resolveBackgroundMotion({ systemReducedMotion })` (`{true}` → `'static'`, `{false}` →
      `'animated'`) is exhaustively unit-tested, `isBoundedMotion` rejects out-of-budget motion (no
      `steps()`, duration ≥ 8000, opacity ≥ 0.35, scale/translate in range), and a render test
      asserts the static leg carries `data-motion="static"`, NO motion `<style>`, and zero
      `animation*` properties (the `@media (prefers-reduced-motion: reduce)` + `[data-motion="static"]`
      CSS gates are declarative belt-and-braces). (b) **Live leg — NAMED
      BLOCKER:** record the raw `matchMedia(...).matches` value and mark the live flip
      **UNVERIFIED** — the Tauri MCP driver exposes no media-emulation API on this host
      (G-050/G-148/#2870); never a blockerless row. (c) **No-strobe:** with animation running, sample
      ≥8 consecutive synchronous frames and compute per-frame mean luminance.
  **Expected:** the static pin PASSES — `resolveBackgroundMotion({ systemReducedMotion: true })`
      → `'static'`, `{ false }` → `'animated'`, `isBoundedMotion` rejects out-of-budget motion and
      every descriptor layer passes; the static render has `data-motion="static"`, NO
      `[data-testid="desktop-backdrop-motion-styles"]` `<style>`, and ZERO `animation*` properties
      (the caption `desktop-background-motion-status` reads `Motion: off (system reduced motion)`
      where it ships). No consecutive-frame
      **luminance inversion** beyond the strobe threshold — quote the raw luminance series; any
      high-frequency full-frame inversion = **FAIL**. A static-only live claim without the pin is not
      acceptable evidence.
  - **Edge:** reduce ON + each option; reduce OFF strobe check; screenshot on both paths.

- [x] **F-35 (Q-8 / R-3.2, AC5):** With a procedural option active, record rAF frame intervals over
      ≥10 s / ≥300 frames, JS heap, and process CPU/GPU idle + during interaction (window
      drag/open/close).
  **Expected:** **zero JS frame loops** (source-grep the background slice for
      `requestAnimationFrame`/`setInterval` — none); animated layers ≤ `MOTION_LAYERS_MAX` (3) and
      constant across the ≥60 s soak (`document.getAnimations()` count + `[data-background-layer]`
      node count stable); every animation duration ≥ `MOTION_DURATION_MIN_MS` (8000); cadence bounded
      (state the target: ~60 fps, no sustained dropped-frame burst); **no unbounded draw**
      (compositor/CSS-driven, no per-frame JS allocation churn); heap **non-growing** across the
      window (report start/end); no perceptible launch/interaction degradation. Any unbounded growth,
      animation-count drift, or sustained high usage = **FAIL** with raw numbers.
  - **Edge:** sustained idle soak (minutes); interaction during animation; two windows;
    reduced-motion on (should be cheaper).

- [x] **F-36 (Q-9 / R-5.1, AC5):** Select **None**; compare the desktop against a pre-#2905 BEFORE
      capture (pixel-comparable; backdrop DOM absent); cold-restart. Then select a procedural option,
      cold-restart, re-open Appearance. Inject a stale/unknown value into
      `Fredo_desktop_background` and restart.
  **Expected:** with None: zero `[data-testid="desktop-backdrop"]` DOM, **zero injected motion
      `<style>`**, the launcher surface carries `NONE_BACKGROUND.css` byte-identically, and the
      desktop is **byte-identical/pixel-comparable** to today's clean desktop. The selection
      (procedural and None) **persists across a full restart** and restores exactly.
      Stale/unknown/empty falls back **safely to None** — no crash, no blank desktop.
  - **Edge:** None after a procedural option; stale id, `''`, `null`, removed id; restart immediately
    after a selection.

- [x] **F-37 (Q-10 / REQ-LIVE, NF):** During the run: `fredo emit --event-type chat --session-id
      e2e-2905-chat` + `--event-type tool_use --session-id e2e-2905-tool --tool-name read_file`;
      query `telemetry_spans` + `chat_rows`/`tool_use_rows` (telemetry-query skill); retain
      screenshot raw URLs + live `tauri_webview_*` receipts.
  **Expected:** `telemetry_spans` **NON-ZERO** with a recent `max(ingested_at)`; both markers
      classify (`user_message` extracted / tool row classified). **A static-only PASS is a FALSE
      PASS.**
  - **Edge:** re-run on the tested tip; keep emit + query output verbatim; do not fabricate a span
    query.

- [x] **F-38 (Q-11 / REQ-NF):** `pnpm --filter @fredo/ui build`; `pnpm --filter @fredo/ui test:run`;
      run the theming + desktop-shell regression suites.
  **Expected:** build exit 0, zero TS errors/warnings; suites green; existing assertions **not
      weakened/disabled/deleted** (the ONLY permitted change is the explicit #2899 static-only
      supersession above).
  - **Edge:** no dangling import; overlap suites green.


### #2905 testing round 1 (spec/2905 @ d64ac959) — results

> Live policy. Serving commit `spec/2905 @ d64ac959`; webview 1920×1017 dpr 1; raw `matchMedia('(prefers-reduced-motion: reduce)').matches` = **false**.

- **F-28 PASS (live, rendered-pixel).** Fixed 5 points P1(300,180) P2(1620,180) P3(960,300) P4(300,850) P5(1620,850); raw-pixel vs None `(21,26,33)`: aurora 5/5, nebula 3/5, mesh 4/5, halo 3/5, constellation 5/5; full-frame scans differ 97.8/58.2/84.6/62.0/97.7 %, topography 4.6 % (peak Δ16). Pairwise min 40.5 % (nebula↔halo). **Disclosure:** topography's 1 px contour bands alias with the canonical points (0/5) — band-hit points differ Δ14–16 (4/5) and the exhaustive scan proves the paint; not a product defect. Evidence images: none/aurora/nebula/mesh/topography/constellation desktops (see verdict).
- **F-29 PASS (live).** Backdrop z=0, `pointer-events:none`; launcher surface (`role=dialog`, z=1100) computed `rgba(0,0,0,0)` for non-none; `elementFromPoint` returns the transparent shell; the pre-fix `tint('var(--body-bg)',72)` veil is removed by ST-1 (diff + invariants pin).
- **F-30 PASS (live).** coffee `#1f140e` 11.58–14.36:1; dark/classic 11.69–14.96:1; light-default 16.18–18.46:1; window title 14.79:1 on its opaque surface; status LED 7.61–9.74:1. Revealed residual: decorative aria-hidden frame ticks ~1.05:1 (non-semantic decoration, None-invariant).
- **F-31 PASS (live).** Mesh dark→light live; accent-primary `#00d1d1`→`#ff00ff` shifted P1 `(10,46,51)`→`(49,14,58)`; unused `cardBg` override left paint unchanged (Δmax 2); reset cleared overrides `{}`.
- **F-32 PASS (live).** `reduce:false`; `data-motion="animated"`; motion `<style>` present; ≥1 running backdrop animation; 8 consecutive rAF frames (~16.5 ms) + 4 tool-spaced samples all distinct.
- **F-33 PASS (live).** Six distinct bounded signatures: aurora drift 45 s/0 normal + 68 s/6000 reverse; nebula breathe 110 s + rotate 110 s + static grain; mesh drift 48/61/74 s staggered; topography sweep 100 s (zero opacity); constellation drift 120 s + twinkle 11 s/0 + 8 s/3500; halo breathe 18 s. All ≤3 layers, all durations ≥8000.
- **F-34 PASS (static pin) with Q-7(b) UNVERIFIED (named blocker).** 5 background files / 64 tests passed (both `resolveBackgroundMotion` legs, `isBoundedMotion` rejections, static render zero `animation*`/no `<style>`). Live `matchMedia` flip not drivable — Tauri MCP driver has no media-emulation API (G-050/G-148/#2870). No-strobe: constellation 8-frame mean-opacity 0.6703→0.6735 monotonic; 6-frame full-frame luminance 0.01086…0.01080.
- **F-35 PASS (live).** 600 frames / 9,966 ms, p50 16.7 ms / p95 16.8 ms / max 16.8 ms; 154 s soak, backdrop layers constant 3, heap +0.16 %; zero rAF/setInterval in the production module.
- **F-36 PASS (live).** None → zero backdrop DOM / zero motion style / `rgb(45,45,45)`+28 px grid (matches #2899 F-20 baseline); mesh and none round-trip cold restarts; AppStore `banana` → safe None fallback, no crash.
- **F-37 PASS (live).** `telemetry_spans` 17597→17603, `max(ingested_at)` 2026-09-20T03:25:11.940Z; `chat_rows` e2e-2905-chat (state init) + `tool_use_rows` e2e-2905-tool (tool_name read_file).
- **F-38 PASS.** `pnpm --filter @fredo/ui build` exit 0 (`✓ 2577 modules`); `test:run` 108 files / 1779 tests passed, 0 failed; only the explicit G-136 supersession inverted (not deleted).

---

## #2909 extension — genuinely perceptible procedural background motion (revises #2905)

> Issue #2909 is a **bug + enhancement revising #2905**: the animated procedural background must be
> **genuinely alive and clearly perceptible** (AC1), the six recipes must read as alive and stay
> **distinguishable by watching** (AC2), reduced-motion must render static with **None byte-identical**
> (AC3), motion must not strobe/jank and stays CPU/GPU-bounded (AC4), and motion must use theme
> tokens with live recolor + legible chrome (AC5). Rows map to the Architect's EARS IDs
> `R-1.1..R-5.2` + QA process rows `V-1..V-3` + the Architect's non-behavioral `NF-1..NF-2` in
> `.opencode/tmp/2909/triage.md` (F-39..F-56).
>
> **THE DEFECT THIS CLOSES:** #2905's F-32/F-33/F-35 proved motion *existed* and stayed *bounded*
> (keyframes present, amplitude bounded, `getAnimations()` signatures) but **never measured rendered
> motion between two times**. A green suite shipped an imperceptible result. Therefore:
> **a computed-style / `getAnimations()` / animation-name PASS is INSUFFICIENT for R-1.1** — the R-1.1
> gate is a **dense/full-frame rendered-pixel diff between frames a defined interval apart**. F-39 is
> the primary row; F-40 makes the signature-only pattern an explicit FAIL.
>
> **G-136 SUPERSESSION (mandatory):** the `#2899`/`#2905` rows that assert *animation presence* via
> signatures are retained as **corroboration only** and must NOT be cited as R-1.1 evidence. The `#2899`
> static-only assertions remain superseded; do NOT re-add them.
>
> **Verification policy: live.** F-53 carries the mandatory `telemetry_spans` receipt; F-54 the gates.
>
> **Constants (TEST-HARNESS constants — QA-owned, NOT product constants; the floors are a *floor*, the
> human read is authoritative):**
> `PERCEPT_INTERVAL_MS=3000` (R-1.1 "≥3 s apart"), `PERCEPT_WINDOW_MS=9000` (full-frame captures at
> 0/3/6/9 s); `PIXEL_DELTA_MIN=8` (per-channel max |Δ|, 8-bit ≈ ΔE76 ≥ 3);
> coverage = changed backdrop pixels / total backdrop pixels;
> **global floor ≥2.0 % per 3.0 s** + **mean region delta ≥1.5/255**;
> **per-recipe floors per 3 s:** aurora/nebula/mesh/halo ≥ **4.0 %**, constellation ≥ **3.0 %**,
> topography (thin-line) ≥ **2.0 %**; **9 s union ≥10 %** (all recipes);
> **phase-spread rule:** ≥2 of the 3 intervals must clear the per-recipe floor (ease-in-out endpoint
> alias); p95 delta ≥8 is a diagnostic, not a gate; noise floor ≤ **0.2 %**;
> #2905's ≈ ±3 %/100 s = **0.09 %/3 s** → rejected by **≥22×** by construction.
> **G-213:** always pair a dense/full-frame diff with (never replace it by) any point sampler.
> The Architect's `data-motion-kind` hook is read in F-43/NF-3.

- [x] **F-39 (R-1.1 — PRIMARY):** For each of the six recipes (`aurora`, `nebula`, `mesh`,
      `topography`, `constellation`, `halo`) select it, confirm no feature window covers the desktop,
      then capture **4 full-frame renders** of the backdrop region at animation times 0/3/6/9 s:
      **deterministic seek leg** (`document.getAnimations()` → `pause()` → set `currentTime`
      0/3000/6000/9000 → screenshot) **and free-running leg** (capture ≈3.0 s ± 0.3 s apart with the
      animation running; record the ACTUAL Δ from timestamps). Diff every interval **densely — every
      pixel of the backdrop rect, no grid subsampling** (G-213).
  **Expected:** per-interval coverage (pixels with max per-channel |Δ| ≥ 8) clears the **global
      2.0 %/3 s** floor **plus mean region delta ≥1.5/255**, and each recipe clears its **per-recipe
      floor** (aurora/nebula/mesh/halo ≥ 4.0 %, constellation ≥ 3.0 %, topography ≥ 2.0 %) in **≥2 of
      the 3 phase-spread intervals**; the 9 s union ≥ **10 %**. Report all 3 intervals per recipe for
      BOTH legs (p95 as a diagnostic). **Both legs must clear** — the seek leg is the reproducible
      judge, the free-running leg proves the animation advances in real time. A computed-style/
      `getAnimations()` PASS, a single frame, a sparse grid, or a single endpoint pair is
      **INSUFFICIENT** → FAIL for R-1.1. A running-but-imperceptible animation (< floor) = **FAIL (the
      #2905 defect)** naming the measured coverage. The seek `pause()` is a MEASUREMENT freeze of the
      live animation — NOT the R-3.1 static render (which removes motion, never pauses it).
  - **Edge:** topography's 1 px/22–23 px contour bands alias a point grid — judge on the dense diff;
    ease-in-out endpoint alias → best-of-2 rule; a window captured over the backdrop; dpr ≠ 1; capture
    latency; a non-seekable animation (`steps()`/JS-driven) → the free-run leg governs and is recorded.

- [x] **F-40 (R-1.2): (a)** noise floor — repeat an **identical-animation-time** capture (Δt = 0) and
      capture the **None** desktop free-run over the window; **(b)** static control — render the F-44
      reduced-motion/static leg and run the same diff; **(c)** state the arithmetic baseline rejection.
  **Expected:** (a) both controls ≤ **0.2 %** coverage (the metric does not invent motion from capture
      noise or shell repaint); (b) a static render reads ≤ **0.2 %**; (c) the floors exceed the #2905
      ≈ ±3 %/100 s (0.09 %/3 s) baseline by **≥22×** by construction. **Any R-1 row whose only
      evidence is `animation-name` / a bounded keyframe / `getAnimations()` / `data-motion="animated"`
      is a FAIL (R-1.2)** — record it as the rejected #2905 pattern.
  - **Edge:** shell/clock repaint inside the sampled region (mask or isolate the backdrop rect); a
    paused-but-seekable animation falsely passing → F-39's free-running leg catches it.

- [x] **F-41 (R-1.1 — human corroboration):** With recipe labels hidden, watch each recipe live for
      ≥ 6 s and answer (a) visibly moving? (b) which recipe is it (motion identity)? (c) continuous,
      not stepped?
  **Expected:** all six: (a) yes, (b) correct identity **6/6**, (c) continuous. The metric is a
      **proxy** — metric PASS + human/vision **no** = FAIL; human **yes** + metric FAIL = a
      threshold/measurement defect that is **recorded and fixed**, never silently passed. Quote the
      question set + answers verbatim.
  - **Edge:** vision model vs human; labels hidden by the tester; shuffled recipe order.

- [x] **F-42 (R-1.3):** Apply F-39 to all six recipes and tabulate (never an aggregate-only read).
  **Expected:** **6/6** recipes clear their per-recipe floor in both legs — no recipe ships a
      sub-threshold (dead) animation. A recipe with a constantly-on `data-motion="animated"` but
      < floor = FAIL naming it.
  - **Edge:** re-select the active recipe (idempotent); each recipe on dark + light.

- [x] **F-43 (R-2): (a)** Read each animated layer's `data-motion-kind`; for each of the 15 recipe
      pairs compare the two rendered frames (identity) **and** their per-pixel **delta maps** (motion
      character); **(b)** blind-label watch — watch the six in shuffled order and name each.
  **Expected:** (a) each recipe exhibits the Architect identity-table vocabulary (kind + cadence +
      structure + amplitude); every pair differs by ≥ **3 %** of pixels (identity) **and** its delta
      maps differ by ≥ **5 %** of pixels (motion character); **no two recipes share an identical motion
      signature** (same kinds + durations + delays + amplitudes). (b) **6/6** correct identification.
      A pair a watcher cannot distinguish = FAIL naming the pair. The #2905 F-33 signature table is
      corroboration only.
  - **Edge:** aurora↔halo (both radial glows); nebula↔constellation (both twinkle); topography (line)
    ↔ mesh (flow); reduced-motion (all static) is not part of this row.

- [x] **F-44 (R-3.1):** Run the unit/static pin — `resolveBackgroundMotion({ systemReducedMotion:
      true })` → `'static'`, `{ false }` → `'animated'`; render the static leg and assert
      `data-motion="static"`, **NO** `[data-testid="desktop-backdrop-motion-styles"]` `<style>`,
      **ZERO** computed `animation*` properties, caption `Motion: off (system reduced motion)`;
      `isBoundedMotion` still rejects out-of-budget motion.
  **Expected:** pin PASSES (from #2905: 5 files / ≥ 64 tests). The static render is the **same
      composition with motion removed** — zero `animation*`, no motion `<style>`, never a paused
      mid-frame animation.
  - **Edge:** reduce ON × each recipe; reduced-motion + None; re-render after a theme switch stays static.

- [ ] **F-45 (R-3.1 — NAMED BLOCKER):** Read raw
      `matchMedia('(prefers-reduced-motion: reduce)').matches`; attempt the live flip.
  **Expected:** live flip **UNVERIFIED — NAMED BLOCKER:** the Tauri MCP driver on this host exposes no
      `prefers-reduced-motion` media-emulation API (documented #2905 F-34; G-050 / G-148 / #2870).
      Record the raw flag value; the leg is closed by the F-44 product-unit pin, **never weakened**
      into a property-only check. **Never a blockerless row.**
  - **Edge:** if a CDP `Emulation.setEmulatedMedia` lever becomes reachable, drive it and lift the
    blocker (record the lever).

- [x] **F-46 (R-3.2):** Select **None**; assert zero `[data-testid="desktop-backdrop"]` DOM + zero
      motion `<style>`; compare `NONE_BACKGROUND.css` against the pre-#2909 baseline (hash / byte
      compare + unit pin); pixel-compare a None desktop screenshot against a BEFORE capture from `main`.
  **Expected:** zero backdrop DOM; zero motion `<style>`; launcher surface carries `NONE_BACKGROUND.css`
      **byte-identical** (unit pin + hash compare); desktop **pixel-comparable** to BEFORE (identical
      dimensions; per-pixel max channel |Δ| ≤ 2 outside the clock/status region — mask the clock). A
      shifted grid/surface color = FAIL.
  - **Edge:** None after each recipe; None after a reduced-motion render; upgrade from a persisted
    recipe; stale/unknown → safe None.

- [x] **F-47 (R-4.1):** With a recipe running, capture ≥ 8 consecutive frames (seek at 0/50/100… ms
      and/or free-run) and compute per-frame full-frame mean luminance; derive an implied flash rate.
  **Expected:** no interval shows a full-frame mean-luminance inversion > **0.5 %** full scale; implied
      flash rate **< 3 Hz** (WCAG 2.3.1); every cycle ≥ 8 s; `steps()` never used; quote the raw
      luminance series per recipe. Any high-frequency inversion = FAIL.
  - **Edge:** each recipe; twinkle recipes (constellation/nebula) are the strobe risk; seek across a
    twinkle boundary.

- [x] **F-48 (R-4.2 + R-4.3):** Record rAF intervals ≥ 600 frames / ≥ 10 s; process CPU idle + during
      interaction; JS heap start/mid/end over ≥ 60 s; `document.getAnimations().length` +
      `[data-background-layer]` count across the soak.
  **Expected:** p50 ≤ **16.7 ms**, p95 ≤ **17 ms**, max ≤ **50 ms**, no > 3 consecutive frames
      > 33 ms; idle CPU ≤ **10 %** of one core, interacting ≤ **25 %**; heap growth ≤ **+2 %**
      (monotonic climb = FAIL); animation + layer counts **constant** (no drift); every duration
      ≥ `MOTION_DURATION_MIN_MS` = 8000; ≤ `MOTION_LAYERS_MAX` = 3 layers; **zero
      `requestAnimationFrame`/`setInterval` in the motion module (R-4.3)**. GPU has no direct counter on
      this host — pacing + CPU + heap are the bounded proxies (named limitation).
  - **Edge:** 60 s idle soak; interaction during animation; two recipes in sequence; reduced-motion
    static is cheaper.

- [x] **F-49 (R-4.2):** Cold-launch with a recipe persisted; measure launch → interactive and
      interaction latency (window open/drag/close, chooser switch) vs the None baseline.
  **Expected:** no perceptible degradation — launch/interaction deltas within noise of the None
      baseline (quote the numbers); no frame-drop burst on launch; UI stays responsive while animating.
  - **Edge:** cold launch with a recipe persisted; recipe switch while animating; window drag during
    animation.

- [x] **F-50 (R-5.1 — static):** Grep the motion slice for hex/rgb/hsl literals, the invalid
      `var(--x)NN` alpha-append, and raster `url()`/`data:`; assert every motion paint derives from
      theme token vars (translucency via `tint()`; layer tint alpha ≤ 45 % over an opaque token ground).
  **Expected:** zero raw color literals in the motion slice (comment issue-refs exempt); no `var(--x)NN`;
      no raster; every paint from a token var. A raw hex in a keyframe = FAIL naming file:line.
  - **Edge:** JS-concatenated 8-digit hex vs `var(--x)NN`; `transparent`/`currentColor` allowed;
    canvas/raster fallback.

- [x] **F-51 (R-5.1):** With a recipe animating, switch dark→light, the reporter's dark/brown preset,
      and set/clear an `accentPrimary` override; capture rendered frames before/after each change and
      re-run the F-39 perceptibility read on the post-switch frames.
  **Expected:** paint recolors live (no restart) from live tokens; the animation keeps running through
      the switch (no frozen/stopped animation); **the perceptibility floor still clears on the
      post-switch render** (a recolor that kills motion = FAIL); an unused-token override does not
      shift the paint; no `Maximum update depth exceeded`.
  - **Edge:** switch mid-animation; chooser open; override set then cleared; light + dark; unused token.

- [x] **F-52 (R-5.2):** On the reporter's dark/brown preset and a light preset, measure shell chrome
      text + window content contrast vs their surfaces on the **worst-motion frame** (a bright moving
      band under the chrome) + ≥ 1 further animated frame. Reference the `desktop-light` and
      `desktop-light-dark-theme-compare` wireframes for the light/dark baseline.
  **Expected:** body ≥ **4.5:1**, large/bold ≥ **3:1**, non-text UI (borders, tiles, ticks) ≥ **3:1**
      on every combination; window content is background-invariant (opaque surface). Quote every
      ratio; a pair below threshold = FAIL naming it.
  - **Edge:** reporter's exact dark/brown preset (state the id — Coffee/Sunset); pale accent + light
    worst case; window over the busiest animated region; worst-motion frame.

- [x] **F-53 (V-1 — live receipt):** During the run: `fredo emit --event-type chat --session-id e2e-2909-chat` +
      `--event-type tool_use --session-id e2e-2909-tool --tool-name read_file`; query
      `telemetry_spans` + `chat_rows`/`tool_use_rows`; retain screenshot URLs + live `tauri_webview_*`
      receipts.
  **Expected:** `telemetry_spans` NON-ZERO with a recent `max(ingested_at)`; both markers classify.
      **A static-only PASS is a FALSE PASS.**
  - **Edge:** re-run on the tested tip; verbatim output; no fabricated span query.

- [x] **F-54 (V-2 — gates):** `pnpm --filter @fredo/ui build`; `pnpm --filter @fredo/ui test:run`; run the
      theming + settings + desktop-shell regressions.
  **Expected:** build exit 0 (zero TS errors/warnings); suites green; existing assertions NOT
      weakened/disabled/deleted. The ONLY permitted supersession remains the explicit
      `G-136 SUPERSEDED (#2905)` static-only legs; the #2905 signature-only rows (F-32/F-33/F-35) are
      retained as **corroboration only** and must not be cited as R-1.1 evidence.
  - **Edge:** no dangling import; overlap suites green; no stale literal test.

- [x] **F-55 (V-3 — procedural only):** Inspect the motion slice + DOM: no `<img>`/raster `url(...)`, no
      bundled media; each animated `[data-background-layer]` carries `data-motion-kind`.
  **Expected:** zero raster assets added; motion is CSS/compositor-driven; no uploaded/bundled image; a
      raster fallback = FAIL.
  - **Edge:** canvas vs CSS recipe; check the built bundle for new image assets.

- [x] **F-56 (Architect NF-1 + NF-2 / G-169 / SA-7):** Unit/static pins — every declared layer envelope
      passes `isBoundedMotion` (translate ≤12 % of the layer box, scale in [0.85, 1.2], rotate ≤4°,
      opacity within [0.35, 1] with swing ≤0.45, duration ≥8000, ≥1 non-zero amplitude envelope);
      `overscanCovers` true for every declarer (worst ≈11.3 % ≤ `MOTION_LAYER_OVERSCAN_PCT` 30); every
      recipe has ≥1 broad-edge PRIMARY moving layer (spatial transition ≤25 % of the box or a
      repeating tile ≤40px). Live: sample the backdrop on a **non-identity transform matrix** frame with
      a window near an edge and confirm **no edge/seam exposure** (an enlarged layer never reveals its
      boundary).
  **Expected:** pins PASS; a no-op motion (no non-zero amplitude) = FAIL; `requiredOverscanPct > 30` =
      FAIL; a visible seam/edge on the moving layer = FAIL naming the layer.
  - **Edge:** worst declared envelope (translate 7, scale 0.90, rotate 0°); a rotate layer's corners;
    two windows near opposite edges; reduced-motion static (overscan still applies — geometry is not an
    animation property).

> **Evidence-renderability guard (G-104):** name evidence frames WITHOUT image extensions in prose;
> `.png`/`.jpeg` tokens only on lines that also carry an `https://` URL; descriptive link labels.
> `upload-evidence` uploads images and prints URLs for the single `## Tests Runs` comment.

### #2909 testing round 1 (spec/2909 @ d2971844) — results

> Live policy. Serving `spec/2909 @ d2971844` (origin tip, re-fetched — G-052 holds). Webview 1920×1017 dpr 1; raw `matchMedia('(prefers-reduced-motion: reduce)').matches` = **false**. Method: pure-Node full-frame PNG diff (PIXEL_DELTA_MIN=8, every pixel, no grid subsampling — G-213).

- **F-39 PASS (live, PRIMARY).** Dense full-frame diff, both legs, all six. Seek max/union: aurora 87.1/97.7, nebula 51.7/58.3, mesh 36.2/49.7, topography 23.4/36.3, constellation 43.7/59.2, halo 40.0/42.5. Free max/union: 91.4/96.6, 48.0/55.0, 33.2/44.5, 23.6/39.3, 38.8/54.7, 38.1/41.0 (free Δ 2571–3183 ms). ≥2-of-3 + max-pair floors clear 6/6; non-identity matrices sampled. Disclosed: mesh/topography/constellation coverage is monotonic-increasing across the fixed 0/3/6/9 window (outbound phase); the full-cycle seek proves the direction reversal and no interval converges.
- **F-40 PASS.** Δt=0 repeats ≤0.051 %; None free-run ≤0.045 %; static leg 0.063 % (animation-name none) — all ≤0.2 %. #2905 0.09 %/3 s rejected ≥22×.
- **F-41 PASS.** Vision read (labels hidden): visibly moving 6/6, identity 6/6, continuous 6/6.
- **F-42 PASS.** 6/6 recipes clear their per-recipe floor in both legs.
- **F-43 PASS.** `data-motion-kind` per recipe distinct; 15-pair frame identity min 47.6 %; delta-map character min 8.3 %.
- **F-44 PASS.** `vitest run background` → 6 files / 96 tests; forcing `data-motion="static"` → computed animation-name none, 0 backdrop animations.
- **F-45 UNVERIFIED — NAMED BLOCKER.** raw matchMedia=false; Tauri MCP exposes no media-emulation API (G-050/G-148/#2870); closed by F-44 (never weakened).
- **F-46 PASS.** None → zero backdrop DOM + zero motion style; `NONE_BACKGROUND.css` byte-identical to main; None render stable at 0.02 %/3 s.
- **F-47 PASS.** 8-frame per-recipe luminance series; max consecutive change 0.36 (≈0.14 % FS) ≪ 0.5 %; every duration ≥8000 ⇒ <3 Hz.
- **F-48 PASS.** rAF 600 frames: p50 16.7 / p95 16.8 / max 16.8 ms, 0 >33 ms; heap +0.69 % over 100.3 s; backdrop counts constant 3/3; zero rAF/setInterval. CPU/GPU named proxies.
- **F-49 PASS.** Apply latency 16.6 / 15.8 / 16.8 ms (recipe/None/mesh); restore/minimize 45.8 / 31.8 ms.
- **F-50 PASS.** Zero colour literals / `var(--x)NN` / raster; `tint()` only; no in-app motion toggle.
- **F-51 PASS.** terminal-green→light-default→coffee→accent override live, animation kept running; post-switch 18.3 / 21.6 / 17.3 / 21.4 %; unused token did not shift paint.
- **F-52 PASS.** coffee chrome 13.2:1 on surface; worst pure-backdrop band 4.54–4.70:1; light 14.8–17.8:1.
- **F-53 PASS (live).** `telemetry_spans` 18923→18931, `max(ingested_at)` 2026-09-20T06:03:53Z; `chat_rows` e2e-2909-chat + `tool_use_rows` e2e-2909-tool/read_file both classify.
- **F-54 PASS.** build exit 0 (2577 modules); `test:run` 108 files / 1805 tests; background 96 tests.
- **F-55 PASS.** 0 raster elements in the backdrop; every animated layer carries `data-motion-kind`.
- **F-56 PASS.** Envelope/overscan pins; live non-identity frame — all three mesh layers' rects extend beyond all four viewport edges (computed inset −305/−576 px), no seam.
