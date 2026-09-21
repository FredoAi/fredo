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

---

## #2915 extension — living Conway's Game of Life desktop background

> Issue #2915 adds a **"Life"** option (Conway's Game of Life, B3/S23) to the Appearance
> Desktop Background chooser alongside **None** (default) and the six procedural recipes.
> Rows map to the QA Plan `F-57..F-72` / AC1–AC5 + the complex scenario in
> `.opencode/tmp/2915/triage.md`.
> **Verification policy: live** — rendered-pixel / DOM+computed-style / restart persistence /
> OS-window-visibility reads on the running app. F-70 carries the mandatory `telemetry_spans`
> receipt; F-71 the gates. The reduced-motion **live OS flip** is undrivable on this host
> (Tauri MCP has no media-emulation API) and is carried as a **named blocker** closed by the
> F-64 product-unit pin (G-050/G-131).
>
> **Relations to the recipe rows (G-136/G-220):** Life is a NEW, separate surface — it does
> NOT supersede any recipe row. The #2905/#2909 signature/perceptibility machinery stays as
> the recipe contract. The "zero `rAF`/`setInterval`" invariant in F-35/F-50/R-26 is scoped to
> `backgroundMotion.ts`; the Life simulation loop must live OUTSIDE it (F-71 scope note).
> `resolveBackgroundMotion` keeps exactly two states; Life adds no new motion status or control.
>
> **G-216/G-221 constant set (TEST-HARNESS constants — QA-owned; the floor is a floor, the
> human read is authoritative):** read the authored `LIFE_STEP_MS` / `LIFE_RESEED_MS` / grid
> `COLS`×`ROWS` / cell footprint from the Life module and RECORD them.
> `PERCEPT_INTERVAL_MS = max(2000, 8 × LIFE_STEP_MS)`;
> `PERCEPT_WINDOW_MS = max(4 × PERCEPT_INTERVAL_MS, 2 × LIFE_RESEED_MS)`; `PIXEL_DELTA_MIN=8`
> (per-channel max |Δ|); coverage = changed backdrop px / backdrop px.
> **Declared gate = the per-interval pairwise dense delta** (window/footprint union = corroboration
> only). **Derived floor:** `LIFE_INTERVAL_FLOOR_PCT = changedCellFractionMin (5 %) × AA (0.6,
> soft edge) × margin (2/3) = 2.0 % per interval` — cells tile the backdrop, so coverage ≈ the
> changed-cell fraction; hard-edged cells → AA = 1.0 and recompute. Noise floor ≤ 0.2 %.
> **G-213:** always pair the dense diff with (never replace it by) any point sampler.
>
> **Evidence mechanics (G-104/G-223):** name evidence frames WITHOUT image extensions in prose;
> `.png`/`.jpeg` tokens only on lines that also carry an `https://` URL; descriptive link labels.
> The `## Tests Runs` draft must carry a literal `Verdict:` line + the footer `*Authored by Tester*`.
> Contract names (UI/UX §0 / Architect API Contracts): `[data-testid="desktop-background-chooser"]`,
> `[data-testid="desktop-background-option-life"]`, `[data-testid="desktop-background-life-thumb"]`
> (+ `data-life-preview="static"`), `[data-testid="desktop-background-life-attribution"]`,
> `[data-testid="desktop-backdrop"]`, `[data-testid="desktop-backdrop-life-canvas"]`
> (+ `data-background-layer="life-field"`, `data-life-motion`, `data-life-running`, `data-life-seed`),
> `[data-testid="desktop-background-motion-status"]`, key `Fredo_desktop_background`.

- [x] **F-57 (AC1a / chooser + fresh default + Life select):** Open Settings → Appearance →
      Desktop Background (`[data-testid="desktop-background-chooser"]`). List the `role="radio"`
      tiles; on a fresh profile (cleared `Fredo_desktop_background`) read the selected tile; click
      `[data-testid="desktop-background-option-life"]`.
  **Expected:** **8** tiles — None + aurora/nebula/mesh/topography/constellation/halo + **Life**
      (`aria-label="Life"`, `data-selected`/`aria-checked` consistent, exactly ONE selected).
      Fresh profile → **None** selected. Selecting Life stamps `[data-testid="desktop-backdrop"]`
      with `data-background-id="life"`; every thumbnail pairwise distinct.
  - **Edge:** re-select the active option (idempotent); rapid None→Life→None churn console-clean
    (no `Maximum update depth exceeded`); G-220 — Life's own tile does not mask None/recipe triggers.

- [x] **F-58 (AC1b / persistence):** Select Life; cold-restart (`dev-env.ps1 -Action Restart`);
      re-open Appearance and read the backdrop + AppStore value. Repeat for None, then Life again.
  **Expected:** Life persists **exactly** across a full restart (tile selected, `data-background-id="life"`
      restored); `Fredo_desktop_background` reads `life`; None persists/restores as None (today's desktop).
  - **Edge:** restart immediately after a change; upgrade from a persisted recipe; a value written by an
    older build; restart while the automaton runs.

- [x] **F-59 (AC1c / stale id — negative/edge):** Inject `banana`, `''`, `null`, `123`, `{}`, and a
      removed id into `Fredo_desktop_background` (AppStore + localStorage); restart each. Then confirm
      `life` round-trips (not treated as stale).
  **Expected:** every stale/unknown value resolves safely to **None** — zero backdrop DOM, today's
      desktop, no throw / no console error / no blank/broken backdrop; `life` restores as Life.
  - **Edge:** absent key vs present-but-empty; AppStore vs localStorage divergence; lenient resolver
    unchanged in spirit.

- [x] **F-60 (AC2a / running B3/S23 + randomized Lexicon seed + random fill):** (a) capture the Life
      canvas (`[data-testid="desktop-backdrop-life-canvas"]`, `data-background-layer="life-field"`) initial
      frame on two fresh loads and read `data-life-seed`; (b) static-read the Life pattern module; (c) confirm
      the chooser thumbnail is static (`[data-testid="desktop-background-life-thumb"]`, `data-life-preview="static"`
      — the engine must not run in the chooser).
  **Expected:** (a) the two initial frames differ densely AND `data-life-seed` differs (per-load
      randomization); (b) a bounded catalogue of **2–4 named Life Lexicon patterns** (record the names) with
      explicit coordinates/RLE, placed at random position/orientation per load, **plus bounded random fill**
      — not uniform noise alone; initial population density inside a stated band (not 0, not 100 %);
      (c) the thumbnail is static (no loop / no canvas engine).
  - **Edge:** no fixed seed; same-process reload vs cold restart; rotation/reflection applied; record the
    density band; both seeded clusters and scattered fill visible; the chooser never runs the engine.

- [x] **F-61 (AC2b / PRIMARY perceptibility, G-216/G-221/G-213):** With Life selected, read the
      authored `LIFE_STEP_MS`/`LIFE_RESEED_MS`/grid caps; set `PERCEPT_INTERVAL_MS = max(2000,
      8 × LIFE_STEP_MS)` and `PERCEPT_WINDOW_MS = max(4 × INTERVAL, 2 × LIFE_RESEED_MS)`; capture
      **dense full-frame renders** (every pixel, no grid subsampling) at 0/¼/½/¾/1 of the window;
      diff each consecutive interval (`PIXEL_DELTA_MIN=8` per channel).
  **Expected:** **≥ 3 of 4** intervals clear the derived floor `LIFE_INTERVAL_FLOOR_PCT` =
      changedCellFractionMin (5 %) × AA (0.6) × margin (2/3) = **2.0 %** (recompute + record from the
      authored cell footprint/grid); window-union ≥ **4.0 %**; **≥ 1 interval ≥ 3 × the median interval
      coverage** (the re-seed discontinuity) inside a window ≥ 2 × `LIFE_RESEED_MS`; no blank (0 %)
      frame. **The gate is the per-interval pairwise dense delta** — the window union is corroboration
      only. A computed-style / `getAnimations()` / `data-motion="animated"` read is **INSUFFICIENT**.
  - **Edge:** G-213 — a sparse fixed-point grid can read near 0 for a coarse pattern; judge the dense
    diff and never conclude "not running" from sparse points; the ≥3-of-4 rule tolerates one lull;
    slow step → widen the interval; hard-edged cells → AA = 1.0; record the actual Δt.

- [x] **F-62 (AC2c / inert behind a present, non-maximized window, G-176):** Open a floating
      (non-maximized) feature window over the Life backdrop at its resting rect; read the backdrop's
      stacking/`pointer-events`/`aria-hidden`; `elementFromPoint` at a point inside the window rect;
      click + type into the focused field.
  **Expected:** backdrop `zIndex:0`, `pointer-events:none`, `aria-hidden="true"`, no `tabIndex`;
      `elementFromPoint` inside the window returns **window content** (never the backdrop); clicks/typing
      land; the backdrop never paints above window content.
  - **Edge:** a maximized-only/absent window is VACUOUS → require the non-maximized resting rect;
    two windows; drag over the animated region; minimized; light + dark.

- [x] **F-63 (AC3 / token-pure + live recolour + light/dark legibility):** (a) static-grep the Life slice
      for hex/rgb/hsl literals + invalid `var(--x)NN`; (b) switch preset Dark→Light Default and set/clear
      an `accentPrimary` override, sampling cell + ground colours; (c) measure cells-vs-ground contrast on
      a light-based **and** a dark-based preset.
  **Expected:** (a) zero literals / `var(--x)NN`; colours pure functions of live theme CSS custom
      properties (translucency via `tint()`/`color-mix`); (b) live recolour **no restart** from live
      tokens, unused-token override does not shift; (c) cells distinguishable from ground (≥ 3:1
      non-text) on both; quote ratios.
  - **Edge:** G-050 — no mode flag; use **presets** (light-default/solarized/arctic/sunset/paper vs
    dark/tokyo-night/nord/matrix/coffee); override set/cleared mid-run; no `Maximum update depth exceeded`.

- [x] **F-64 (AC4a / reduced motion → static, no loop):** (a) run the product-unit/render pin:
      `resolveBackgroundMotion({ systemReducedMotion: true })` → `'static'`; assert ZERO
      `requestAnimationFrame`/`setInterval` scheduled, generation counter constant, `data-motion="static"`,
      no motion `<style>`, a full (non-blank) static frame. (b) read the raw live
      `matchMedia('(prefers-reduced-motion: reduce)').matches`.
  **Expected:** (a) pin PASSES — animation **removed, not paused mid-frame**: the loop is never started,
      `data-life-running="false"` + `data-life-motion="static"`, zero rAF/timers; (b) live flip
      **UNVERIFIED — NAMED BLOCKER** (Tauri MCP exposes no media-emulation API — G-050/G-148/#2870);
      record the raw flag.
  - **Edge:** reduce ON × each preset; re-render after a theme switch stays static; a loop still
    scheduled (paused but live) = FAIL; never blockerless.

- [x] **F-65 (AC4b / animated leg — no strobe):** With Life animating (reduce OFF) capture ≥ 8
      consecutive dense frames; compute per-frame **full-frame mean luminance**.
  **Expected:** no interval shows a full-frame mean-luminance inversion > **0.5 %** full scale; implied
      flash rate **< 3 Hz** (WCAG 2.3.1); quote the raw luminance series per preset. `data-motion="animated"`
      / a non-empty canvas alone is INSUFFICIENT (G-216; perceptibility is judged by F-61).
  - **Edge:** a re-seed must not produce ≥ 3 consecutive full-frame inversions; local cell toggling is
    not a full-frame flash — the metric is the full frame.

- [x] **F-66 (AC5a / procedural-only + bounded grid/step/memory):** (a) static — no `<img>`/raster
      `url(...)`/`data:` image URI, no new binary asset, bounded curated pattern catalogue; (b) record the
      authored named caps (`COLS × ROWS`, `LIFE_STEP_MS`, `LIFE_RESEED_MS`, buffer use); (c) ≥ 60 s soak.
  **Expected:** zero raster; caps named + bounded; heap growth ≤ **+2 %** (a monotonic climb = FAIL);
      grid/step/buffer counts constant; canvas backing-store ≤ ≈1.5 × viewport; no unbounded growth.
  - **Edge:** dpr scaling; minutes-long soak; build + suite gates; no full-lexicon dump.

- [x] **F-67 (AC5b / pause when not visible, G-123 WHILE):** With Life animating read the canvas
      `data-life-running` + `data-life-seed`; minimize/switch away (`document.visibilityState === 'hidden'`);
      wait ≥ 5 s; re-read; restore.
  **Expected:** `data-life-running` flips to **`"false"`** while hidden (loop **cancelled**, not merely
      skipped) and back to `"true"` on restore; a dense diff of two frames captured ≥ 5 s apart while hidden
      reads ≤ the 0.2 % noise floor (frame frozen). A `"true"`/advancing state while hidden = FAIL.
  - **Edge:** **named blocker (G-053)** if the runtime hook is absent on the tested build → mark UNVERIFIED
    with that blocker and fall back to `visibilityState` + the frozen-frame dense diff; minimize vs
    switch-away vs occluded; restore latency.

- [x] **F-68 (AC5c / CC BY-SA 3.0 attribution — static + live):** Read the Life pattern-definition module +
      docs; live-read `[data-testid="desktop-background-life-attribution"]` under the chooser.
  **Expected:** a **CC BY-SA 3.0** attribution + licence notice at the pattern definitions (source
      header/comment naming the Life Lexicon + the licence) **and** a docs note **and** the always-visible
      in-app notice (`Patterns: Life Lexicon (Stephen Silver), CC BY-SA 3.0.`); bounded curated subset
      (no verbatim full-lexicon dump).
  - **Edge:** a notice only in a commit message / external URL (not in-repo) = FAIL; full-lexicon bundle = FAIL.

- [x] **F-69 (CX / complex scenario — still evolving + re-randomizes):** Given Life selected and motion not
      reduced, when the backdrop has run ≥ the F-61 window and ≥ 2 × `LIFE_RESEED_MS`, then the automaton
      is still visibly evolving and re-randomizes rather than freezing into a still life or blank grid.
  **Expected:** per-interval dense delta clears the floor in ≥ 3 of 4 intervals; ≥ 1 re-seed discontinuity;
      the end-of-window frame ≠ the initial frame; population never 0 / never a whole-window freeze.
      Human/vision corroboration (watch ≥ 6 s: evolving? yes; frozen/blank? no) — metric PASS + human
      "frozen" = FAIL.
  - **Edge:** long re-seed period → extend the window; slow step → widen the interval; record timestamps;
    a single-phase window must not be read as a one-shot settle.

- [x] **F-70 (NF-live / receipt):** `fredo emit --event-type chat --session-id e2e-2915-chat` +
      `--event-type tool_use --session-id e2e-2915-tool --tool-name read_file`; query `telemetry_spans` +
      `chat_rows`/`tool_use_rows`; retain screenshot URLs + live `tauri_webview_*` receipts.
  **Expected:** `telemetry_spans` **NON-ZERO** with a recent `max(ingested_at)`; both markers classify.
      **A static-only PASS is a FALSE PASS.**
  - **Edge:** re-run on the tested tip; verbatim output; never fabricate a span query.

- [x] **F-71 (NF-gate / gates + no test weakening):** `pnpm --filter @fredo/ui build`;
      `pnpm --filter @fredo/ui test:run`; run the theming + settings + desktop-shell regressions.
  **Expected:** build exit 0 (zero TS errors/warnings); suites green; existing assertions not
      weakened/disabled/deleted. **Scope note:** the Life rAF loop must NOT trip F-35/F-50/R-26 (scoped to
      `backgroundMotion.ts`) — those plus `background.invariants.test.tsx`'s zero-rAF / ≥1-layer /
      exactly-6-descriptor pins must be **re-scoped to the CSS-recipe modules**, with a NEW bounded-loop pin
      for the Life engine (single rAF; cancelled on static/hidden/unmount; no unbounded timers). The only
      permitted supersession remains the explicit #2899 static-only legs.
  - **Edge:** no dangling import; overlap suites green.

- [x] **F-72 (G-220 / resolver + forcing recipes):** Validate each state's forcing recipe against the
      shipped mapping (`BackgroundSettings.tsx:162` — each tile `<button role="radio">`
      `onClick={() => select(id)}`): `none` / the 6 recipes / `life` each have their own tile.
  **Expected:** selecting each of the 8 options reaches **exactly** that state; `life` masks no existing
      state's only trigger; `resolveBackgroundMotion` still has exactly two states and Life adds no new
      motion status or extra control.
  - **Edge:** keyboard roving-tabindex walk reaches Life; the motion-caption contract is unchanged.

### #2915 testing round 1 (spec/2915 @ a3c7f245) — results

> Live policy. Serving `spec/2915 @ a3c7f245`; webview 1920×1017 dpr 1. Authored constants read from
> `background/life/lifeConstants.ts`: `LIFE_CELL_PX=12`, grid cap `160×100`, `LIFE_STEP_MS=160`,
> `LIFE_RESEED_GENERATIONS=150` (`LIFE_RESEED_MS=24 000`), `LIFE_RESEED_PATTERNS_MIN..MAX=2..4`,
> `LIFE_FILL_DENSITY=0.10`, density band `0.04..0.30`, `LIFE_DPR_MAX=1.5`, `LIFE_LUMA_INVERSION_MAX=0.005`,
> `LIFE_PATTERN_COUNT=10`. Derived harness window: `PERCEPT_INTERVAL_MS=max(2000,8×160)=2000`,
> `PERCEPT_WINDOW_MS=max(4×2000,2×24000)=48 000` → 5 captures at Δ≈12 000 ms.

- **F-57 PASS (live).** Chooser 8 radios (`desktop-background-option-{none,aurora,nebula,mesh,topography,constellation,halo,life}`), exactly one `aria-checked="true"`; fresh profile (cleared `Fredo_desktop_background`) → None + zero backdrop DOM; selecting Life stamps `data-background-id="life"` + tile `data-selected="true"`, `localStorage`/AppStore `life`; rapid None→Life→None ×3 console-clean.
- **F-58 PASS (live).** Life selected → `dev-env.ps1 -Action Restart` → restored `data-background-id="life"`, Life canvas running (seed 3341529482); None selected → restart → zero backdrop DOM.
- **F-59 PASS (live).** Injected `banana`/`''`/`null`/`123`/`{}`/`plasma` into AppStore + localStorage; each reload → zero `desktop-backdrop` DOM, zero canvas, today's desktop, no console error; `life` round-trips as Life.
- **F-60 PASS (live+static).** Two fresh Life loads → seeds 2054583544 vs 2888176597 (differ), initial frames dense-differ 11.974 % of pixels, painted-field fraction 7.06 %/6.65 % (density band); cross-load seed 4001973412 after a real page reload; static catalogue = exactly 10 named patterns (glider, LWSS, blinker, toad, block, beehive, pulsar, acorn, R-pentomino, Gosper glider gun) with explicit coordinates, 2–4 placed/load + 10 % bounded fill; thumbnail `desktop-background-life-thumb` present, `data-life-preview="static"`, SPAN+SVG, zero canvas in the settings tree.
- **F-61 PASS with a disclosed calibration residual (live, PRIMARY).** 5 dense full-frame captures at Δ=12 002/12 000/12 000/12 000 ms: interval coverage 3.913 / 5.575 / 3.557 / 5.674 % → **4 of 4 clear** the derived floor (plan reference `5 %×0.6×2/3=2.0 %`; recomputed from the shipped `LIFE_CELL_PX=12` geometry, drawn-cell area `(1−2×0.14)²=0.5184` → 1.73 %; gated on the stricter 2.0 %); window union **12.065 %** ≥ 4.0 %; no blank frame (non-ground 2.49–3.51 %). **Residual:** the `≥1 interval ≥3× median` re-seed-discontinuity clause did NOT reproduce at the declared 12 s cadence (max 5.674 % vs 3×median 14.232 %; a 16×3 s sweep: max 4.982 % vs 7.803 %) — the 24 s re-seed period is harmonically locked to the 12 s interval. The discontinuity IS directly observed at step granularity (fine ~100 ms sweep: 8.447 % single-sample jump at t=14.671 s vs 1.92 % median = **4.4×**; population 2.1→6.7 %). Recorded for QA-metric calibration.
- **F-62 PASS (live, G-176).** Non-maximized Settings window at its resting rect 480×320 (48,48); backdrop `zIndex:0`, `pointer-events:none`, `aria-hidden="true"`, no `tabIndex`; `elementFromPoint` at 3 points inside the window rect returns window content (HEADER/DIV), never the backdrop; clicks land (Halo→Life) and typing lands ("inert-probe" reached the focused field) while Life animates.
- **F-63 FAIL (live, light-based leg) — expected-vs-actual below.** (a) PASS: zero hex/rgb/hsl literals and zero `var(--x)NN` in the Life slice (grep + `lifeBounds.test.ts` source pin). (b) PASS: preset switch + `accentPrimary` override recolour the painted ground/cell live with no restart (dark `rgb(8,16,16)`→light `rgb(255,255,255)`; override `#ff00ff` → painted cell `rgb(248,0,248)`, reset → `#00d1d1`; unused-token no-op). (c) **FAIL — cells-vs-ground (non-text ≥ 3:1) misses on every light-based preset:** light-default `#00d1d1` on `#ffffff` = **1.90:1**; solarized 2.93:1; arctic 2.51:1; sunset 2.52:1; paper 2.81:1 (dark = 9.96:1 PASS). Hook: `lifeEngine.ts paint()` draws `tokens.cell = --accent-primary` over `tokens.ground = --body-bg`; the accent token is below 3:1 on all five light grounds. Repro: Settings → Appearance → Theme Presets → each light preset → read the painted cell/ground from the Life canvas. Vision note: the cells remain clearly visible (chroma contrast) — the miss is the luminance-ratio bar, but the stated numeric clause is unmet.
- **F-64 PASS(product pin) + UNVERIFIED (live flip) — NAMED BLOCKER.** (a) `vitest run background` → `lifeBounds.test.ts` (8) + `lifeEngine.test.tsx` (12): reduced-motion leg schedules **zero** rAF/`setTimeout`/`setInterval`, `data-life-motion="static"`, `data-life-running="false"`; `resolveBackgroundMotion({true})→'static'`, `{false}→'animated'` (backgroundMotion.test.ts:60-68). (b) raw `matchMedia('(prefers-reduced-motion: reduce)').matches = false`; the live OS flip is **UNVERIFIED** — the Tauri MCP driver exposes no media-emulation API (G-050/G-148/#2870) and `tauri_manage_window minimize` needs plugin ≥0.13 (host older). Closed by the product-unit pin.
- **F-65 PASS (live).** dark preset 9 consecutive dense frames over 3.609 s: mean-luminance series 0.990057…0.989645 (light-default) / 0.083726…0.074806 (dark); max consecutive |ΔL| = 0.051 % FS (light) / 0.792 % FS (dark, a single one-sided re-seed density drop at t≈0.95–1.40 s); **zero luminance inversions > 0.5 % FS** (no opposing pair); implied flash rate ≪ 3 Hz.
- **F-66 PASS (live+static).** Zero raster (`url()`/`data:`/<img> absent from the slice); authored caps recorded; 90 s soak → canvas backing store constant 1920×1017 (= 1.0× CSS viewport, ≤ `LIFE_DPR_MAX` 1.5 linear), heap 238.3→240.5 MB (+0.92 %) pre-GC then GC to 53.8 MB — no monotonic climb, no unbounded growth.
- **F-67 PASS (live) + NAMED BLOCKERS.** Synthetic visibility trigger (real `visibilitychange` handler with `document.hidden` overridden — the native minimize/hide is undrivable: plugin <0.13 + no `core:window:allow-hide`): `data-life-running` "true"→**"false"** (loop cancelled) →"true" on restore; dense diff of two frames 6 s apart while "hidden" = **0.000 %** (≤ 0.2 % noise floor). `document.visibilityState` itself stays `visible` (only `document.hidden` is overridable) — disclosed.
- **F-68 PASS (live+static).** Source header `lifePatterns.ts:6-21` (Life Lexicon / Stephen A. Silver / CC BY-SA 3.0; bounded authored subset, "the full Life Lexicon dataset is NEVER bundled"); docs `docs/features/desktop-background-life.md:17-41`; live `desktop-background-life-attribution` = `Patterns: Life Lexicon (Stephen Silver), CC BY-SA 3.0.`; exactly 10 patterns (module-load guard).
- **F-69 PASS (live, complex).** Per-interval dense delta clears the floor 4/4; end frame ≠ initial frame; fine-grain sweep shows a re-seed discontinuity (8.447 % jump; population 2.1→6.7 %) and no blank/whole-window freeze; human/vision read of t0 vs t1 (≈4 s apart): evolving — yes; frozen/blank — no.
- **F-70 PASS (live).** `fredo emit --event-type chat --session-id e2e-2915-chat` + `--event-type tool_use --session-id e2e-2915-tool --tool-name read_file`; `telemetry_spans` total **24 959**, `max(ingested_at) 2026-09-21T07:34:25.127Z` (recent); `chat_rows` e2e-2915-chat state=init ×2; `tool_use_rows` e2e-2915-tool tool_name read_file ×2.
- **F-71 PASS.** `pnpm --filter @fredo/ui build` exit 0 (2582 modules, only the pre-existing chunk advisory); `pnpm --filter @fredo/ui test:run` **115 files / 1700 tests passed, 0 failed**; background suite 9 files / 140 tests; `git diff main spec/2915 --stat` shows the ONLY test-expectation edits are `BackgroundSettings.test.tsx` (7→8 radios, End→`life`) + purely additive `DesktopBackdrop.test.tsx`/new Life files — no assertion weakened/disabled/deleted; `background.invariants.test.tsx` byte-identical.
- **F-72 PASS (live).** Each of the 8 tiles reaches exactly its state (None → zero backdrop; six recipes → their layers; Life → the canvas); exactly one selected/checked per click; `resolveBackgroundMotion` still exactly two states; no new control/motion status.

### #2915 testing round 2 (spec/2915 @ 79a80c1b) — results

> Re-test after the round-1 F-63 FAIL fix (`79a80c1` — cell token `--accent-primary` → `--accent-strong`).
> Live policy. Serving `spec/2915 @ 79a80c1b`; webview 1920×1017 dpr 1; raw
> `matchMedia('(prefers-reduced-motion: reduce)').matches = false`. **Verdict: PASS (16/16 rows).**

- **F-57 PASS (live).** 8 radios, exactly one `aria-checked="true"`; fresh profile (cleared AppStore + localStorage) → None + zero backdrop DOM/canvas; Life → `data-background-id="life"`, tile `data-selected`, `localStorage` `life`, canvas running; document canvas count 1.
- **F-58 PASS (live).** Life → `dev-env.ps1 -Action Restart` → restored (new seed 1391331599, running true); None → restart → AppStore `none`, zero backdrop/canvas.
- **F-59 PASS (live).** `banana`/`''`/`{}`/`123`/removed `plasma` → zero backdrop DOM, today's desktop, console clean; `life` round-trips (seed 1465378034). `null` rejected by the typed `save_setting` command (`invalid type: null, expected a string`).
- **F-60 PASS (live+static).** seeds 3479934306 vs 4190341673; loaded-frame cell-grid diff 7.772 %; 10-pattern catalogue; thumbnail SPAN+SVG `data-life-preview="static"`, zero canvas in the settings tree.
- **F-61 PASS (live, PRIMARY) with the disclosed calibration residual.** Dense full-frame Δ=12 s intervals 4.832 / 4.378 / 5.219 / 3.930 % (4/4 ≥ 2.0 %); union 4.578 %; no blank frame. **Residual:** the `≥1 interval ≥3× median` clause is harmonically locked at 12 s (24 s re-seed period = 2× multiple); observable at fine granularity — **120 ms consecutive dense-diff max 9.455 % vs 2.18 % median = 4.34×** (t=28.813 s), and painted-population step 0.419 pp vs 0.03 pp median = 13.97×.
- **F-62 PASS (live, G-176).** Non-maximized 480×320 @ (48,48) window; backdrop z=0 / `pointer-events:none` / `aria-hidden` / no tabindex; `elementFromPoint` ×4 → window content; nav click + typed "inert-probe" landed while Life animated.
- **F-63 PASS (live+static) — round-1 FAIL fixed.** (a) zero literals / `var(--x)NN`. (b) painted-canvas recolour live, no restart (light-default cell `#057b7d` → override `#ff00ff` → `#920897` 7.767:1; pale `#7dd3fc` → `#4a7c95` 4.557:1; reset → base 5.497:1; unused `cardBg` override no shift). (c) **painted cell-vs-ground non-text ratios: light-default 5.078, solarized 3.742, arctic 4.588, sunset 4.729, paper 5.051 (all ≥3:1); dark 11.508, coffee 10.172.** Full-canvas histogram proves the `color-mix`-derived cell was actually painted (no ground fallback).
- **F-64 PASS (product pin) + UNVERIFIED (live flip) — NAMED BLOCKER.** `vitest run background` 9 files / 140 tests; `lifeBounds` 8/8 + `lifeEngine` 12/12 (static leg zero rAF/timers). No media-emulation API on the host (G-050/G-148/#2870); closed by the pin.
- **F-65 PASS (live).** dark 11-frame max consecutive |ΔL| = 0.171 % FS; light-default 12-frame max = 0.219 % FS; zero inversions > 0.5 % FS; implied flash ≪ 3 Hz.
- **F-66 PASS (live+static).** Zero raster; authored caps; clean 70.004 s soak heap start 36.97 → peak 37.29 MB (**+0.882 %**), end 37.16 MB, 6 GC decreases, no monotonic climb; canvas backing store constant 1920×1017 (1.0× CSS viewport).
- **F-67 PASS (live) + NAMED BLOCKERS.** `data-life-running` true→**false**→true via `document.hidden` override + the real `visibilitychange` handler; hidden full-frame diff over **15.365 s = 0.000 %**; post-restore evolving 2.486 %/1.5 s. Native minimize/hide undrivable (plugin <0.13; no `core:window:allow-hide`); `document.visibilityState` stayed `visible` — disclosed.
- **F-68 PASS (live+static).** `lifePatterns.ts:6-21` + `docs/features/desktop-background-life.md:17-41` + live `desktop-background-life-attribution`; 10 patterns.
- **F-69 PASS (live, complex).** 4/4 intervals clear; re-seed discontinuity 9.455 % vs 2.18 % median = 4.34×; end frame ≠ initial; population never 0; vision (light-default frames apart): evolving yes, frozen/blank no.
- **F-70 PASS (live).** `telemetry_spans` total **25 497**, `max(ingested_at) 2026-09-21T08:05:23.266Z`; `chat_rows` e2e-2915-chat init ×2; `tool_use_rows` e2e-2915-tool read_file ×2.
- **F-71 PASS.** build exit 0 (2582 modules); `test:run` **115 files / 1700 tests**; `background.invariants.test.tsx` byte-identical; only chooser 7→8 + additive test edits.
- **F-72 PASS (live).** All 8 options reach exactly their state; one selected per click; two motion states; no new control.

---

## #2925 extension — a calmer, less glaring Life backdrop (revises #2915)

> Issue #2925 revises #2915: the shipped Life field is **too bright and nearly monochrome**. It must be
> rendered **materially dimmer** with **reduced single-hue dominance**, while staying **perceptibly
> animated** and keeping foreground legibility. Rows map to the QA Plan `Q-1..Q-16` / AC1–AC5 in
> `.opencode/tmp/2925/triage.md` (new rows `F-73..F-88`). No prior row is superseded.
> **Verification policy: live** — rendered-pixel / DOM+computed-style / restart persistence /
> visibility reads on the running app. F-87 carries the mandatory `telemetry_spans` receipt; F-88 the
> gates. The reduced-motion live OS flip stays a **named blocker** (Tauri MCP has no media-emulation
> API — G-050/G-148/#2870), closed by the F-81 product-unit pin.
>
> **G-136 — RE-BASELINE, NOT SUPERSESSION.** The historical `F-57..F-72` / `S-20..S-23` / `R-29..R-33`
> records stand, unedited. This section **extends** their expected values for the dimmed field
> (`F-61` → `F-75`; `F-63` → `F-76`; `S-20..S-23` → `S-24..S-27`; `R-29..R-33` → `R-34..R-38`) and adds
> the new AC1 luminance/dominance audit `F-73`/`F-74`.
>
> **Measurement definitions (identical on BOTH legs).**
> - **Field luminance** = arithmetic MEAN of per-pixel WCAG relative luminance
>   `L = 0.2126·R' + 0.7152·G' + 0.0722·B'` (8-bit sRGB linearized: `c/255 > 0.04045` →
>   `((c/255 + 0.055)/1.055)^2.4`, else `(c/255)/12.92`) over the **unmasked Life backdrop rect** of the
>   **composited desktop capture** (windows closed — so an overlay-based dim is captured). Shell chrome
>   (clock/status/launcher strip) masked per the F-46 recipe (max per-channel delta ≤ 2 outside the
>   clock). Report mean / median / p95 / share of pixels with `L > 0.5`.
> - **Dominance** = painted pixels are those with per-channel delta > 8 from the modal ground colour;
>   the dominant band is the 30°-wide HSL hue band containing the most painted pixels (near-neutral
>   painted pixels with `S < 0.10` excluded). **Dominance share** = painted pixels in that band / all
>   painted pixels. **Dominant-hue saturation** = mean HSL `S = (max−min)/max` of those pixels.
> - **Perceptibility** = coverage (changed backdrop px / total) at `PIXEL_DELTA_MIN = 8` per-channel max
>   delta; the **gated quantity is the per-interval pairwise dense delta** (G-221); window/footprint
>   union is corroboration only. Apply it to the **resolved (dimmed) tokens**, never the pre-dim render.
> - **Materiality floors (QA-proposed; the Architect's declared dim target supersedes when stronger):**
>   field luminance **≥ 10 % relative reduction**; dominance **≥ 25 % relative share reduction OR ≥ 0.10
>   absolute saturation reduction**. Identical-frame repeats must read ≤ 1 % relative (E-51).
>
> **New expected baselines (open Q6).** #2915 recorded cell-vs-ground ratios
> light-default 5.078:1, solarized 3.742:1, arctic 4.588:1, sunset 4.729:1, paper 5.051:1,
> dark 11.508:1, coffee 10.172:1; perceptibility 3.913–5.674 % per 12 s interval against the
> 2.0 %/interval floor. After #2925 the SAME metrics are expected to read: field luminance **≥ 10 %
> relative lower**, dominance share **≥ 25 % relative lower OR** dominant-hue saturation **−0.10
> absolute**, perceptibility **still ≥ 2.0 %/interval** (the floor is NOT traded away), cell-vs-ground
> **still ≥ 3:1 on every preset**, foreground chrome **still ≥ 4.5:1 body / ≥ 3:1 non-text**. Record the
> actuals; a metric that regresses below its #2915 value is a FAIL naming it.

- [ ] **F-73 (AC1a / Q-1 — BEFORE→AFTER rendered-field luminance, the dimming leg):** Materialise the
      BEFORE tip (`dev-env.ps1 -Action Up -Spec 2925 -At <pre-change-tip>` — the #2915 merge tip on
      `main`; record the SHA), select **Life** with all feature windows closed, capture the composited
      desktop; repeat on the tested tip. Compute mean field luminance per the definitions above.
      **Expected:** AFTER mean field luminance is materially lower than BEFORE — QA hard floor **≥ 10 %
      relative reduction** (UI/UX design direction **≥ 20 % relative** on light-based presets; the
      Architect's declared target supersedes when stronger, recorded). On dark-based presets judge
      primarily on the **painted-pixel luminance** leg (the frame mean is ground-dominated). Report
      mean / median / p95 / glare share for BOTH legs. **Restore to the tested tip per G-163** (`git checkout -f <tested-tip>`,
      verify `git status --porcelain` clean + every tip-deleted file absent, record the served commit)
      BEFORE any AFTER leg.
      **Edge:** no live BEFORE cycle reachable → the pre-authorized fallback column (removed-code diff +
      arithmetic composite + durable #2915 recorded values), with the empirical numbers disclosed as
      **UNVERIFIED**, never fabricated; identical-frame measurement noise ≤ 1 % relative (E-51);
      shell-chrome mask; Life on both a light and a dark preset.
- [ ] **F-74 (AC1b / Q-2 — reduced single-hue dominance):** On the same BEFORE/AFTER frames histogram
      painted pixels (per-channel delta > 8 from the modal ground) by HSL hue; compute the dominant 30°
      band share and its mean saturation.
      **Expected:** dominance is **reduced** — **dominant-hue mean saturation/chroma reduction ≥ 0.10
      absolute (PRIMARY)** — AND the field still carries ≥ 1 painted hue (not neutralised to a flat
      grey). The **share** branch alone cannot fire under a uniform field-wide dim (lit-cell pixel share
      is unchanged), so it is OR-only corroboration, never the sole gate (UI/UX Q4). Record band centre /
      share / mean saturation on both legs.
      **Edge:** a dim that lowers luminance only, with dominance unchanged, is a FAIL on this leg;
      near-neutral painted pixels (S < 0.10) excluded identically on both legs; the mechanism
      (accent-mix vs per-cell alpha vs darker ground) is the Architect's call — the row measures the
      observable only.
- [ ] **F-75 (AC2 / Q-3 — perceptibility on the RESOLVED dimmed tokens; extends F-61, G-216/G-221/G-228):**
      Read the authored `LIFE_STEP_MS` / `LIFE_RESEED_MS` / grid caps / cell footprint and RECORD them;
      set `PERCEPT_INTERVAL_MS = max(2000, 8 × LIFE_STEP_MS)`,
      `PERCEPT_WINDOW_MS = max(4 × INTERVAL, 2 × LIFE_RESEED_MS)` (= 48 000 ms shipped),
      `PIXEL_DELTA_MIN = 8`; sample at `PERCEPT_SAMPLE_MS = 10 000` ms — **off-harmonic** (re-seed
      24 000 / 10 000 = 2.4; record the ratio). Capture **dense full-frame** diffs (every pixel, no grid
      subsampling) of the rendered backdrop via an **in-page accumulator** (`window.__lifePerceptSamples`
      — test-only sampler diffs each tick against the previous and pushes `{t, coveragePct, meanAbsDelta}`)
      polled by the driver in **bounded calls each < 3 s** (G-229 — never one long in-page call).
      **Expected:** **≥ 3 of 4** intervals clear the derived floor `LIFE_INTERVAL_FLOOR_PCT` (recompute
      from the authored cell footprint — shipped `(1−2×0.14)² = 0.5184 × 5 % × 2/3 ≈ 1.73 %`, gated on
      the stricter **2.0 %/interval**); window union **≥ 4.0 %**; **≥ 1 interval ≥ 3 × median** (the
      re-seed discontinuity) OR the fine-granularity probe (consecutive dense diffs at ≈ 2 ×
      `LIFE_STEP_MS`) reported raw; **no blank (0 %) / frozen frame**; the human read (two screenshots +
      ≥ 6 s watch) confirms the field is **evolving**. **The gate is the per-interval pairwise dense
      delta — `PIXEL_DELTA_MIN`, the interval, the window and the floor are FIXED.** A sub-floor reading
      is the measured **dim-vs-perceptibility FAIL (dimmed into invisibility)** — never lower
      `PIXEL_DELTA_MIN` to pass. Metric PASS + human "frozen" = FAIL.
      **Edge:** thin margin (baseline 3.93–5.22 %/interval vs the 2.0 % floor) — a dim that scales
      per-channel frame deltas below 8 collapses coverage; single-phase window; harmonic lock (G-228) →
      report the raw series rather than looping; canvas-pixel vs composited read disclosed; slowness →
      widen the interval; hard-edged cells → AA = 1.0.
- [ ] **F-76 (AC3a / Q-4 — cell-vs-ground ≥ 3:1 on every preset, on the DIMMED field; extends F-63,
      G-227):** Sample the painted cell colour vs ground on **all 20 shipped rows** — 18 built-ins
      (`themePresets`, `app/types/theme.ts:233`) + `turbo` + `classic` — **re-baselining** the 7 #2915
      presets (light-default, solarized, arctic, sunset, paper, dark, coffee); **solarized is the
      acceptance-binding row** (~32 % field-wide dim headroom; ground-only darkening breaks it at ~10 %
      sRGB).
      **Expected:** painted cell-vs-ground non-text ratio **≥ 3:1 on EVERY of the 20 rows**; quote the
      dimmed AFTER ratios beside the #2915 baselines (5.078 / 3.742 / 4.588 / 4.729 / 5.051 / 11.508 /
      10.172). **A dim that trades any row below 3:1 = FAIL naming the preset + pair.** Arbitrary user
      accents cannot be floor-guaranteed at baseline → gate them on **no regression vs the same accent
      pre-dimming** and document the user's choice.
      **Edge:** pre-validate the exact painted token pair per preset (G-227) — a token swap that
      changes the painted pair must be re-measured; light vs dark `--body-bg`; unused-token override; a
      mechanism that dims ground and cells unequally shrinks the ratio.
- [ ] **F-77 (AC3b / Q-5 — foreground legibility vs the dimmed field; UI/UX sign-off):** Measure
      shell-chrome text (command bar, clock, tiles, ticks) vs its effective backdrop containing the
      dimmed field, and window content vs its opaque surface, on a **light** and a **dark**
      preset/accent.
      **Expected:** UI/UX validates body text **≥ 4.5:1**, large/bold **≥ 3:1**, non-text UI **≥ 3:1**
      on BOTH; quote every ratio. UI/UX owns the sign-off; QA binds the rendered-pixel measurement and
      the floors.
      **Edge:** compare against a **None / Life-absent control** — the dim must not *reduce* chrome
      contrast; window content is background-invariant (opaque surface); pale accent + light worst case;
      window over the busiest field region; a dimming overlay must not sit above a window (F-85).
- [ ] **F-78 (AC4a / Q-6 — zero literals + zero `var(--x)NN`, extends `lifeBounds.test.ts`):** Static
      grep the Life slice for hex/rgb/hsl literals and the invalid `var(--x)NN` alpha-append pattern;
      extend the `lifeBounds.test.ts` source pin to cover the new dim expression.
      **Expected:** ZERO colour literals (comment issue-refs exempt) and ZERO `var(--x)NN` alpha-append
      in the Life slice; the dim is a pure function of live theme CSS custom properties via
      `tint()`/`color-mix`. A canvas `ctx.fillStyle` cannot consume `var()` — the dim expression must be
      **browser-resolved** (derived CSS vars registered in `ThemeProvider` next to `--accent-strong`, or
      `getComputedStyle` on a probe) and defined **ONCE as a shared paint-expression constant** consumed
      by the live engine, the canvas style, and the thumbnail so they cannot drift. Any literal or
      alpha-append = FAIL naming file:line.
      **Edge:** distinguish a JS-concatenated 8-digit hex (OK); `transparent`/`inherit`/`currentColor`/
      `none` allowed; an inline `rgba()` in the component = FAIL; the pre-existing stale
      `--accent-primary` mention in `backgroundRegistry.ts` is a comment (not a literal) — but see F-86.
- [ ] **F-79 (AC4b / Q-7 — live recolour, no restart):** Switch preset (light-default → dark) and
      set/clear an `accentPrimary` override while Life runs; sample the rendered cell/ground before and
      after each change.
      **Expected:** the dimmed field recolours **live with no restart** and derives from the live tokens
      (the dim expression re-resolves on the theme change); no stale colour; no
      `Maximum update depth exceeded`.
      **Edge:** rapid churn; chooser open during the switch; override set then cleared; the dim must not
      double-apply/stack on a re-render.
- [ ] **F-80 (AC4c / Q-8 — unused-token negative pin):** Override a token the Life field does **not**
      consume (pick it from the authored `resolveLifeTokens` consumption list — e.g. `cardBg`) and
      re-sample the rendered field; then revert.
      **Expected:** the field paint does **NOT shift** beyond the noise floor (≤ 1 % relative mean
      luminance / max per-channel delta ≤ 2); reverting restores the prior paint exactly.
      **Edge:** a field that shifts on an unconsumed token = FAIL; use the authored consumption list,
      not an assumed token set.
- [ ] **F-81 (AC5a / Q-9 — reduced motion = one seeded static frame, zero rAF/timers):** (a) run the
      product-unit/render pin with `resolveBackgroundMotion({ systemReducedMotion: true })`; (b) read
      the raw live `matchMedia('(prefers-reduced-motion: reduce)').matches`.
      **Expected:** pin PASSES — `data-life-motion="static"`, `data-life-running="false"`, ZERO
      `requestAnimationFrame`/`setInterval` scheduled, generation counter constant, a full (non-blank)
      seeded frame (motion REMOVED, not paused mid-frame). (b) live flip **UNVERIFIED — NAMED BLOCKER**
      (Tauri MCP exposes no media-emulation API — G-050/G-148/#2870); record the raw flag.
      **Edge:** reduce ON × presets; a theme switch during the static render stays static; a
      paused-but-live loop still scheduled = FAIL; never blockerless.
- [ ] **F-82 (AC5b / Q-10 — per-load seed + periodic re-randomize policy unchanged):** Two fresh loads
      → read `data-life-seed`; watch ≥ 2 × `LIFE_RESEED_MS`.
      **Expected:** per-load seed **differs** between loads; the automaton still re-randomizes on the
      authored cadence (a discontinuity is observed); no freeze into a still life or blank grid; the
      dimming must NOT alter the `lifeConstants.ts` seed/re-seed policy.
      **Edge:** same-process reload vs cold restart; long re-seed period → extend the window; the seed
      value itself is not asserted, only that it varies.
- [ ] **F-83 (AC5c / Q-11 — pause-when-hidden: loop CANCELLED, not merely skipped):** Flip the real
      `visibilitychange` handler with `document.hidden` overridden; read `data-life-running`;
      dense-diff two frames ≥ 5 s apart while hidden; restore.
      **Expected:** `data-life-running` flips `"true"` → **`"false"`** (the rAF loop is **cancelled**,
      not merely skipped) → `"true"` on restore; the hidden-window dense diff ≤ the 0.2 % noise floor;
      post-restore the field advances again.
      **Edge:** native minimize/hide undrivable (plugin < 0.13; no `core:window:allow-hide`) — disclosed;
      a `"true"`/advancing state while hidden = FAIL; restore latency; occluded vs switch-away.
- [ ] **F-84 (AC5d / Q-12 — bounded grid/cadence/DPR/memory caps unchanged):** (a) read the authored
      caps (`COLS × ROWS`, `LIFE_STEP_MS`, `LIFE_RESEED_MS`, `LIFE_DPR_MAX`, `LIFE_FILL_DENSITY` band);
      (b) ≥ 60 s soak reading JS heap + canvas backing-store size.
      **Expected:** caps byte-unchanged vs #2915; heap ≤ **+2 %** with no monotonic climb; canvas
      backing store ≤ 1.5 × viewport (shipped = 1.0×) and constant; the dimming adds **no new unbounded
      structure and no second rAF/timer**.
      **Edge:** dpr scaling; minutes-long soak; a dim implemented as an extra render pass must not add a
      loop; the dim must not allocate per frame (no churn); build + suite gates.
- [ ] **F-85 (AC5e / Q-13 — inert backdrop, unchanged):** Open a non-maximized feature window over the
      Life backdrop at its resting rect; read stacking / `pointer-events` / `aria-hidden` / `tabIndex`;
      `elementFromPoint` inside the window rect; click + type into the focused field.
      **Expected:** backdrop `zIndex: 0`, `pointer-events: none`, `aria-hidden="true"`, no `tabIndex`;
      `elementFromPoint` returns **window content** (never the backdrop, never a dimming overlay);
      clicks/typing land; the backdrop never paints above window content.
      **Edge:** a dimming OVERLAY must sit on the same z=0 layer below `WindowManager` — an overlay
      above a window = FAIL; maximized / floating / minimized; two windows; drag over the field; light
      + dark.
- [ ] **F-86 (AC5f / Q-14 — chooser-thumbnail consistency; open Q5):** Compare
      `[data-testid="desktop-background-life-thumb"]` (`data-life-preview="static"`) against the live
      dimmed field.
      **Expected:** the thumbnail does not visibly contradict the live dimmed field (same cell/ground
      token family, comparable dominance). Per the UI/UX disposition (**FIX IN-SLICE, Q5**):
      `LifeThumbnail.tsx` must paint from the **same resolved dimmed cell/ground expression** as the live
      engine (not raw `var(--accent-primary)`, stale vs the canvas's `--accent-strong`), mirror the dim
      via the shared paint constant, and the stale `LIFE_BACKGROUND` comment in `backgroundRegistry.ts`
      must be corrected. A thumbnail that still promises a brighter/different field = FAIL.
      **Edge:** a bright thumbnail beside a dimmed field = contradiction → FAIL or a named disposition;
      thumbnail stale after a token change; `data-life-preview="static"` preserved (no engine in the
      chooser).
- [ ] **F-87 (NF-live / Q-15 — receipt):** `fredo emit --event-type chat --session-id e2e-2925-chat` +
      `--event-type tool_use --session-id e2e-2925-tool --tool-name read_file`; query `telemetry_spans` +
      `chat_rows`/`tool_use_rows`; retain screenshot URLs + live `tauri_webview_*` receipts.
      **Expected:** `telemetry_spans` **NON-ZERO** with a recent `max(ingested_at)`; both markers
      classify. **A static-only PASS is a FALSE PASS.**
      **Edge:** re-run on the tested tip; verbatim output; never fabricate a span query.
- [ ] **F-88 (NF-gate / Q-16 — gates + no test weakening):** `pnpm --filter @fredo/ui build`;
      `pnpm --filter @fredo/ui test:run`; run the theming + settings + desktop-shell regressions.
      **Expected:** build exit 0 (zero TS errors/warnings); suites green; no existing assertion
      weakened/disabled/deleted; the recipe-module zero-rAF pins and `background.invariants.test.tsx`
      stay byte-identical; zero literals / `var(--x)NN` / raster in the slice.
      **Edge:** no dangling import; the new `lifeBounds.test.ts` pins are order-independent/deterministic
      (G-222); overlap suites green.
