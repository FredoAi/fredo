# Launcher — Regression

> "Must not change" baseline for the launcher shell (issue #2808). If any row FAILS, the
> change regressed existing behavior. Run on the spec branch.
> **Serving checkout:** `spec/2808 @ 28ef8b1c`. Round 1.

## Baseline invariants
- [x] R-1: The launcher chrome no longer imports `@maomaolabs/core` (grep returns zero in the shell source) — the third-party `Toolbar` launcher is replaced by our own component.
  - **PASS.** Zero `@maomaolabs/core` in `launcher/` + `Home.tsx`; `DesktopToolbar.tsx` deleted.
- [x] R-2: `SHOWABLE_FEATURES` is sourced from `apps/ui/src/features/home/components/Home.tsx:22` (`getFeatures().filter(f => f.showable)`) — the grid is never a hardcoded list; it reflects the live feature registry.
  - **PASS.** `Home.tsx:22` `const SHOWABLE_FEATURES = ALL_FEATURES.filter((feature) => feature.showable)`; passed to `<LauncherShell showableFeatures={SHOWABLE_FEATURES}>`. Live grid = the 4 showable features; non-showable absent.
- [x] R-3: The own window-manager kernel contract (#2807) is unchanged (used, not modified): `openWindow` params shape (`id/title/icon/component/canClose/canMaximize/canMinimize/isMaximized`), spawn semantics (`windowStore.ts:68-91`), spread-merge `updateWindow` (R-4), idempotent/re-entrancy-guarded `closeWindow`.
  - **PASS for the contract.** The launcher routes opens through `onOpenFeature(id, feature)` → Home `openFeatureWindow` → own-kernel `openWindow` (Home.tsx:77-129); the kernel store/actions files under `shared/window-system/` were untouched by #2808 (git `ST-1` diff shows only the `DesktopToolbar`→`LauncherShell` swap). **Separate latent defect discovered in AC2b** (NOT a #2808 modification): the window-manager container `position:absolute; z-index:auto` (`WindowManager.tsx:25`) renders BELOW the `DesktopBackground` (z-index 0, later DOM) so opened windows are occluded by the desktop. Flagged for the Architect — this is a kernel/Home-layout z-order issue, not a contract modification.
- [x] R-4: Existing feature launches from other entry points (settings button, konami code, self-open) still open the feature via `apps/ui/src/features/home/components/Home.tsx:77-129 openFeatureWindow`.
  - **PASS.** `openFeatureWindow` (the single full-lifecycle opener) is unchanged; the launcher routes through it, and the konami/settings/self-open paths still call it. The only defect affecting all opens is the shared window-occlusion z-order (R-3 note) — it is a kernel-layout defect, not a launcher regression.
- [x] R-5: Theme token-first: no hardcoded hex/rgba; `tint()` helper for hover; no alpha-append onto `var()`; Chakra v3 only.
  - **PASS.** Launcher source grep: zero hardcoded hex/rgba; `tint('var(--accent-primary)', 14/22)` hover/selected; `tint('var(--body-bg)', 55)` overlay; Chakra v3 (`InputGroup`/`startElement`/`endElement`, not `NativeSelect`); the avatar is `currentColor` + accent var.
- [x] R-6: No re-render loop — the launcher consumes the window-store epoch / uses `useMemo`; no effect depends on array `.length` or newly-created object refs (AGENTS.md re-render-loop rule).
  - **PASS.** Launcher uses `useMemo` for `filteredEntries`, `useRef` for `prevWindowCountRef`, and a stored `setInterval` (60s) for the clock — no effect depends on array `.length` or new object refs. Console across the run had zero `Maximum update depth exceeded` / re-render-loop warnings.

## Overlapping prior suites
- (none yet — first suite for the launcher surface)
