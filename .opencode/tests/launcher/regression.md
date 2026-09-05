# Launcher — Regression

> "Must not change" baseline for the launcher shell (issue #2808). If any row FAILS, the
> change regressed existing behavior. Run on the spec branch.

## Baseline invariants
- [ ] R-1: The launcher chrome no longer imports `@maomaolabs/core` (grep returns zero in the shell source) — the third-party `Toolbar` launcher is replaced by our own component.
- [ ] R-2: `SHOWABLE_FEATURES` is sourced from `apps/ui/src/features/home/components/Home.tsx:22` (`getFeatures().filter(f => f.showable)`) — the grid is never a hardcoded list; it reflects the live feature registry.
- [ ] R-3: The own window-manager kernel contract (#2807) is unchanged (used, not modified): `openWindow` params shape (`id/title/icon/component/canClose/canMaximize/canMinimize/isMaximized`), spawn semantics (`windowStore.ts:68-91`), spread-merge `updateWindow` (R-4), idempotent/re-entrancy-guarded `closeWindow`.
- [ ] R-4: Existing feature launches from other entry points (settings button, konami code, self-open) still open the feature via `apps/ui/src/features/home/components/Home.tsx:77-129 openFeatureWindow`.
- [ ] R-5: Theme token-first: no hardcoded hex/rgba; `tint()` helper for hover; no alpha-append onto `var()`; Chakra v3 only.
- [ ] R-6: No re-render loop — the launcher consumes the window-store epoch / uses `useMemo`; no effect depends on array `.length` or newly-created object refs (AGENTS.md re-render-loop rule).

## Overlapping prior suites
- (none yet — first suite for the launcher surface)
