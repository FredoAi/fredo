# Wireframe Contrast — Functional

> Durable functional suite for the **Wireframe contrast** domain (first seeded at Spec #3086:
> make every Wireframe label/control legible in any shipped theme). Rows map 1:1 to the QA Plan
> in `.opencode/tmp/3086/triage.md` `## QA Expert` (`Q-1`..`Q-11`; keyed to the Architect's EARS
> ids `R-1`, `R-1.1`, `R-2`, `R-3`, `R-4`). Names bind verbatim to the Architect's BINDING NAMES
> BLOCK — do not invent divergent surface ids, pair ids or `data-contrast-*` anchors.
>
> **Verification policy: live.** A contrast check emits NO span/row/metric, so a
> `telemetry_spans` receipt is **not** expected here and its absence is not a missing receipt.
> Required evidence per rendered row: a quoted live `tauri_webview_*` result
> (`execute_js` / `find_element` / `dom_snapshot`) carrying the anchor and the OBSERVED computed
> `color`/`background-color` plus the recomputed ratio. **Never a screenshot judgement.** A
> static-only PASS (gate green, rendered leg not run) is a **false PASS** (G-366) and fails closed.
>
> **Anchors (names block §4):** `data-contrast-pair="<surface>|<state>|<pairId>"` on the element
> whose computed `color` is the row's fg; where fg and bg live on different elements,
> `data-contrast-fg="<row>"` / `data-contrast-bg="<row>"`. Page-settings anchors:
> `segmented|default|track`, `segmented|selected|indicator`, `segmented|default|label`,
> `segmented|selected|label` (SegmentedField); `number-input|default|label`,
> `number-input|default|stepper`, `slider|default|track`, `slider|default|range`,
> `slider|default|thumb` (NumberSliderField). Other surfaces: `subtle|default|chip-label`
> (status bar), `status-solid|default|label` (Discard), `banner|default|label` (file error),
> `canvas|default|fallback-label` (canvas). Reused testids: `wireframe-page-presets`,
> `wireframe-page-preset-{desktop|tablet|phone}`, `wireframe-page-width-number`,
> `wireframe-page-height-number`, `wireframe-toolbar`, `wireframe-status`,
> `wireframe-new-document-discard`, `wireframe-new-document-dialog`, `wireframe-panel-title`,
> `wireframe-panel-caption`, `wireframe-page-controls`.

## Harness (run before every leg)

- **Isolated env:** `.opencode/scripts/dev-env.ps1 -Action Up -Spec 3086 -EnvId wf3086-a -EnvSlot 1`;
  driver `tauri_driver_session start` with `appIdentifier` = the env's MCP port as a decimal
  string. Never `Restart` (G-328) — recover with `Down` then `Up`.
- **Theme switch:** Settings → Appearance (`select[aria-label="Theme presets"]`); record the
  preset id from the 19 shipped presets (`matrix.ts:117-123`). Use ≥ 1 light + ≥ 1 dark.
- **Recompute oracle:** in `execute_js`, read
  `import('/@fs/.../apps/ui/src/app/theme/contrast/wcag.ts')` for `parseColor`/`contrast`, or
  reimplement the WCAG relative-luminance ratio inline. Resolve each anchor's fg = computed
  `color`, bg = computed `background-color` (or the paired `data-contrast-bg` element).
- **Floors:** body 4.5 (`BODY_FLOOR`, `wcag.ts:95`), ui/border/focus 3 (`UI_FLOOR`, `wcag.ts:97`).
- **Captures:** `.opencode/tmp/3086/e2e/<row>-<state>.jpeg` (supplementary only, never the oracle).

## R-1 / AC1 — page-settings panel

- [ ] **F-1 (R-1 / Q-1, light):** In the RUNNING app, open Wireframe with NOTHING selected
      (page-settings panel visible) under a shipped LIGHT theme. For each page-settings anchor
      recompute the ratio from computed styles.
      **Expected:** `segmented|default|label` ≥ 4.5 · `segmented|selected|label` ≥ 4.5 ·
      `number-input|default|label` ≥ 4.5 · `number-input|default|stepper` ≥ 3 ·
      `slider|default|track` ≥ 3 · `slider|default|range` ≥ 3 · `slider|default|thumb` ≥ 3 ·
      `wireframe-panel-title` (`fg.default` on `bg.surface`) ≥ 4.5 ·
      `wireframe-panel-caption` (`fg.muted` on `bg.surface`) ≥ 4.5. Quote each anchor + observed
      values + ratio.
      **Edge:** selected AND unselected segments (incl. the derived `Custom` state with NO chip
      selected); both `Page width` and `Page height` fields; ≥ 2 shipped light presets.
- [ ] **F-2 (R-1 / Q-2, dark):** repeat F-1 under a shipped DARK theme.
      **Expected:** same floors hold; no anchor below floor. Quote the preset id.
      **Edge:** ≥ 2 dark presets (the darkest + the highest-contrast shipped dark).
- [ ] **F-3 (R-1.1 / Q-3, rendered leg anchors):** Assert every page-settings anchor exists and
      exposes a parseable rendered fg/bg; assert the recomputed rendered ratio equals the static
      gate row's `ratio` within ±0.05 for the non-composed page-settings rows.
      **Expected:** all anchors present; both computed values parse; rendered ≈ gate (±0.05) —
      the gate and the paint agree (G-366). A divergence means the painted token ≠ the gated
      token → FAIL + REPORT to the Orchestrator (never call `block`, G-394).
      **Edge:** fg/bg on different elements; a segment mid-transition; the selected indicator
      overlay.
- [ ] **F-4 (R-2 / Q-4, other surfaces, light):** recompute the ratio live for the other
      Wireframe surfaces: toolbar (`control-ghost|default|label` ≥4.5, `hover` ≥4.5,
      `pressed` ≥4.5), status bar (`subtle|default|chip-label` ≥4.5), dialog
      (`surface|default|overlay-label` ≥4.5, `status-solid|default|label` ≥4.5), file-error
      banner (`banner|default|label` ≥4.5, `|icon` ≥3, `|border` ≥3), canvas fallback
      (`canvas|default|fallback-label` ≥4.5).
      **Expected:** every pair ≥ floor in a light theme.
      **Edge:** hover/pressed on toolbar buttons; dialog OPEN (`wireframe-new-document-dialog`);
      banner forced via `FREDO_WIREFRAME_FAIL_FILE=1`; `Pan` chip active.
- [ ] **F-5 (R-2 / Q-5, other surfaces, dark):** repeat F-4 in a dark theme.
      **Expected:** same floors hold.
      **Edge:** darkest + highest-contrast dark presets.
- [ ] **F-6 (R-3 / Q-6, static gate):** run `pnpm --filter @fredo/ui contrast:gate`; in
      `contrastGate.test.ts` call `buildContrastMatrix()`; assert the 36 new Wireframe
      `PAIR_SPECS` rows are present for every one of the 19 presets and each row carries
      `key/presetId/surface/state/pairId/kind/ratio/floor/composed`; assert
      `gatePairsWithinContract()` true.
      **Expected:** exit 0; 19 × new-rows present; every new surface
      (`segmented`/`slider`/`number-input`/`control-ghost`/`status-solid`/`banner`) represented;
      `gatePairsWithinContract()` true; `evaluateContrast` reports a below-floor row as a
      violation.
      **Edge:** `*exempt` rows floor-reported, never a violation; boundary `ratio === floor` not
      a violation; just-below → violation.
- [ ] **F-7 (R-3 / Q-7, determinism + G-235):** assert two `buildContrastMatrix()` calls are
      deep-equal; assert the new rows introduce no DOM/fs/random; assert every new row computed
      on all 19 presets clears its floor (pre-validation).
      **Expected:** deep-equal matrices; no new below-floor row on any preset; the high-risk
      rows (`control-ghost|pressed|label`, `slider|default|track`, `segmented|default|track`)
      clear or are re-tokened with the SAME row identity; the floor is never lowered.
      **Edge:** each of the 19 presets individually.
- [ ] **F-8 (R-4 / Q-8, raw colour):** run the Wireframe pin `noRawColors.test.ts` and the
      shipped scanner
      `evaluateRawColors(scanRawColors(defaultScanTargets()), RAW_COLOR_ALLOWLIST, RAW_COLOR_BASELINE, RAW_COLOR_BASELINE_MAX)`;
      grep the changed Wireframe sources for `#rrggbb`/`rgb(`/`rgba(`/`hsl(`/`hsla(`/
      `var(--x)NN` and bare named colours.
      **Expected:** pin green; `violations.length === 0` and `staleBaseline.length === 0`; no
      new literal other than `transparent`/`inherit`/`currentColor`/`none`; the `data-contrast-*`
      attributes introduce no colour literal; `tint()` used for tints (no `var()NN` alpha-append).
      **Edge:** a `tint()`-derived surface; a literal inside a comment (stripped); an allowlisted
      file + a NEW literal (reported).
- [ ] **F-9 (R-4 / Q-9, Discard no-regression):** assert the `status-solid|default|label` row
      (`status.onSolids` on `status.error`) is present in `buildContrastMatrix()` and ≥ 4.5 on
      all 19 presets; live: `wireframe-new-document-discard` computed
      `color`/`background-color` recompute ≥ 4.5.
      **Expected:** gate row present, ≥ floor on every preset; live ratio ≥ 4.5.
      **Edge:** hover state; the dialog open over the scrim.
- [ ] **F-10 (R-4 / Q-10, build):** `pnpm --filter @fredo/ui build` (zero TS errors);
      `pnpm --filter @fredo/ui test:run` green (Wireframe + contrast suites);
      `pnpm --filter @fredo/ui contrast:gate` green; `cargo check` (if Rust touched) zero
      warnings.
      **Expected:** all green; no existing assertion weakened/disabled/deleted.
      **Edge:** `system.semanticTokens.test.ts`, `contrastGate.test.ts`,
      `contractConsumption.test.ts`, `pageControls.test.tsx`, `WireframePropertyPanel.test.tsx`
      unchanged.
- [ ] **F-11 (NFR / Q-11, canvas chrome):** the Konva canvas chrome cannot be read via DOM
      `getComputedStyle`; read the SAME CSS vars from `document.documentElement` (`--card-bg`,
      `--border-color`, `--text-primary`, `--accent-primary`, `--accent-strong`, `--status-*`,
      `--accent-contrast`) and recompute the canvas pair ratios.
      **Expected:** each canvas pair ≥ floor in both a light and a dark theme.
      **Edge:** a shape whose fill equals the page background (border still visible);
      theme-switch repaint.
