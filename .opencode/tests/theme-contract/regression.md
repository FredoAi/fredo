# Theme Contract — Regression

> "Must not change" baseline for #3034 (theme contract). The contract and the gate are
> **read-only instruments over the theme engine** — #3034 must NOT change rendered behaviour, the
> theme engine layer order, or the #3033 gate's semantics. Run this file alongside
> `.opencode/tests/contrast-gate/regression.md` and `.opencode/tests/theming/regression.md`
> (overlapping surface) whenever a spec touches theming tokens or the gate.

## Invariants (must NOT change)

- [ ] **R-1 (gate not regressed):** `pnpm --filter @fredo/ui contrast:gate` remains green; the
      #3033 negative suite `apps/ui/src/app/theme/contrast/__tests__/contrastGate.negative.test.ts`
      passes unchanged for BOTH dimensions (matrix + raw colour). The gate command name and the
      `Contrast gate` CI step (`.github/workflows/validate.yml`) are preserved.
- [ ] **R-2 (baseline caps only shrink):** `rawColorBaseline.ts` `RAW_COLOR_BASELINE_MAX` (128) and
      `contrastBaseline.ts` `BASELINE_MAX` (184) are never raised by #3034; the ratchet-down and
      stale-entry rules in `rawColorEvaluate.ts` / `evaluate.ts` are unchanged; every entry still cites
      a live issue number (#3035).
- [ ] **R-3 (theme engine layering untouched):** `ThemeProvider.tsx` derives tokens with the exact
      `overrides ?? preset ?? classic base` order and the `color-mix()` derivations
      (`--accent-strong` 55/45, `--text-subtle` 65/35, `--accent-contrast` WCAG-max). The contract
      documents/derives from this — it does not re-implement or diverge from it. Reference
      `.opencode/tests/theming/regression.md` R-1..R-34.
- [ ] **R-4 (preset data unchanged at the value level):** the 18 built-in preset token values in
      `apps/ui/src/app/types/theme.ts` and the `classic` base are unchanged by the contract
      refactor; `PRESET_IDS` still resolves to the base + 18 built-ins; `themes.turbo` stays excluded
      (base locked to `classic`).
- [ ] **R-5 (read-only gate):** the contrast modules contain no `writeFile`/`fs.write*`/`setProperty`
      — the gate never writes source, baseline, or allowlist.
- [ ] **R-6 (no product-code behaviour change):** #3034 owns the contract module, the theming token
      definitions, and gate wiring only. It makes component colours derive from the contract; it does
      not introduce new component-local overrides and does not change rendered appearance except where
      the contract intentionally re-derives a token (which must be a reviewed PR diff).
- [ ] **R-7 (whole suite + build green):** `pnpm --filter @fredo/ui test:run` green;
      `pnpm --filter @fredo/ui build` exit 0 (zero TS errors); no new runtime/test dependency.

## Overlapping suites to run alongside

- `.opencode/tests/contrast-gate/` (#3033) — the gate's own matrix + raw-colour functional, regression,
  smoke and exploratory suites; #3034 must keep them green.
- `.opencode/tests/theming/` — theme engine / preset / override invariants; the contract reads the
  same token layers (F-13 Settings chrome contrast AA; F-25/F-27 literal/alpha-append scans overlap).
- `.opencode/tests/desktop-chrome/`, `.opencode/tests/settings/` — surfaces that consume theme tokens.
