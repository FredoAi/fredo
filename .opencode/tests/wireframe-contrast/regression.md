# Wireframe Contrast — Regression

> The "must not change" baseline for the Wireframe-contrast domain (Spec #3086) plus links to the
> prior feature suites whose surface this spec overlaps. Run on every testing phase that touches
> the Wireframe chrome or the contrast gate / theme contract.
>
> **Overlapping prior suites (run them too):**
> - `.opencode/tests/wireframe/` — the Wireframe application domain (editor, page controls,
>   toolbar, status bar, dialogs). Its `F-8` (colour hygiene / palette shape) and `F-21`/`F-30`
>   (page controls / page presets) overlap this spec directly.
> - `.opencode/tests/contrast-gate/` — the shipped contrast gate (`matrix.ts` `PAIR_SPECS`,
>   `evaluateContrast`, baseline semantics, raw-colour scan, CI wiring). This spec EXTENDS that
>   gate; its `F-1`..`F-11` must stay green.
> - `.opencode/tests/theme-contract/` — the theme contract (`SEMANTIC_TOKENS`, `SurfaceId`,
>   `ControlState`, `CONTRACT_PAIRS`). This spec ADDS vocabulary; the existing enumeration must
>   not regress.
> - `.opencode/tests/theming/`, `.opencode/tests/theme-contrast-drain/` — theme/contrast
>   accumulation surfaces.

## Regression invariants (must not change)

- [ ] **R-1 (no floor lowered):** `BODY_FLOOR` stays `4.5` (`wcag.ts:95`), `UI_FLOOR` stays `3`
      (`wcag.ts:97`); no existing `PAIR_SPECS` row's `floor` is reduced.
- [ ] **R-2 (no ledger growth):** `BASELINE_MAX` stays `0` (`contrastBaseline.ts:28`);
      `CONTRAST_BASELINE` stays EMPTY; a NEW below-floor pair fails immediately (never baselined).
- [ ] **R-3 (no row identity churn):** the pre-existing `PAIR_SPECS` rows (`matrix.ts:314-364`)
      keep their `surface|state|pairId` identity and their `ratio`; only ADDITIVE rows land.
- [ ] **R-4 (gate ⊆ contract):** `gatePairsWithinContract()` (`matrix.ts:388-395`) stays `true`
      for every gate row (existing and new).
- [ ] **R-5 (#3081 Discard no-regression):** `WireframeToolbar.tsx:574-575` still paints
      `bg="status.error" color="status.onSolids"`; the Discard-button contrast does not regress
      (now gate-guarded by `status-solid|default|label`).
- [ ] **R-6 (noRawColors pin green):** `apps/ui/src/applications/wireframe/__tests__/noRawColors.test.ts`
      stays green — no raw-colour literal introduced (`transparent`/`inherit`/`currentColor`/`none`
      excepted), and the new `data-contrast-*` attributes introduce no colour literal.
- [ ] **R-7 (existing Wireframe tests pass):** `pageControls.test.tsx`,
      `WireframePropertyPanel.test.tsx`, `WireframeToolbar.hotkeys.test.tsx` stay green; the
      `wireframe-*` testids are unchanged (anchors are additive).
- [ ] **R-8 (theme contract tests pass):** `system.semanticTokens.test.ts`,
      `contrastGate.test.ts`, `contractConsumption.test.ts` stay green; no existing assertion is
      weakened, disabled or deleted.
- [ ] **R-9 (build clean):** `pnpm --filter @fredo/ui build` exits 0 with zero TS errors.
- [ ] **R-10 (no behaviour/layout/copy change):** the page-settings panel, toolbar, status bar,
      canvas, dialogs and banner keep their behaviour, layout and copy — colour/contrast only.

## Prior-suite quick re-run

- [ ] **R-11:** run `.opencode/tests/wireframe/functional.md` `F-8` (colour hygiene / palette
      shape) — still PASS (no wireframe entry in `contract/allowlist.ts`; the 12-key palette
      unchanged).
- [ ] **R-12:** run `.opencode/tests/contrast-gate/functional.md` `F-1`..`F-11` — all still PASS
      (the gate extension is additive).
