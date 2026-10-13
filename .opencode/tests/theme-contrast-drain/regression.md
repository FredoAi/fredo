# theme-contrast-drain — regression

> "Must not change" baseline for Spec #3035. A colour/contrast fix must not alter
> behaviour, tokens elsewhere, or the theme contract.

- [ ] R-1: No behaviour change — the existing `database-client` component tests
      (`ConnectionForm`, `ExportMenu`, `SqlEditor`, `QueryTabs`, `ResultsGrid`, …)
      and `settings-app` tests still pass unchanged.
- [ ] R-2: Token/theme contract intact — no token is renamed or re-valued outside the
      fix; `apps/ui/src/app/theme/` remains the single source of truth; other presets
      unchanged (the gate is preset-wide).
- [ ] R-3: No raw colour introduced — the gate's raw-colour scan over
      `applications/**` + `system.ts` stays green; no `#hex`/`rgba(`/`var(--x)N`.
- [ ] R-4: Enabled/disabled/loading/empty states still behave (Save gating, Export at
      0 columns, Run disabled, status strip variants) — only their colour changed.
- [ ] R-5: `Experience` — no `NativeSelect` reintroduced; `chakra.select` + CSS-var
      props remain the dropdown pattern.
- [ ] R-6: Prior overlapping suites: the #3033 gate suites
      (`apps/ui/src/app/theme/contrast/__tests__/`) remain green with the drained ledger
      (the test pins are updated, not defeated).

## Links
- `docs/ENGINEERING_RULES.md` (Chakra token/colour rules).
- `.opencode/tests/README.md`.
