# setup — Regression

> "Must not change" baseline for the Setup auto-open removal + launcher tile (Issue #3010).
> Run on the `spec/3010` tip. **Verification policy: live** — a static-only PASS is a FALSE PASS.

## R-1 — Home desktop does NOT open Setup on mount (regression pin, G-123 continuous)

- [ ] R-1: Mount the Home desktop with `plugin_installed` UNSET (the falsy condition that used to
      fire) and advance timers past 1200 ms.
  **Expected:** NO Setup window opens; `settingsService.get` is never called with `plugin_installed`.
  - **Static unit pin (ST-3, non-AC):** `apps/ui/src/applications/home/components/__tests__/Home.noAutoSetup.test.tsx`
    mounts Home, advances fake timers, asserts no Setup window + no `plugin_installed` read — must
    PASS unmodified.
  - **Live leg:** F-1 (fresh boot, samples +0 / +1.4 s / +5 s) and F-7(a).
  - **Edge:** reload (`Ctrl+R`) re-holds; boot with an empty/fresh store.

## R-2 — The launcher grid still enumerates the live feature registry (no hardcoded list)

- [ ] R-2: The grid tiles equal `SHOWABLE_FEATURES.map(f => f.name)` for the tested tip; the
      `setup` feature is registered exactly once (no ghost/duplicate tile). Reference
      `.opencode/tests/launcher/regression.md` R-2 and `.opencode/tests/launcher/functional.md` F-48.
  - **Edge:** `dedupeByApplicationId` still keeps one tile per id.

## R-3 — Existing feature opens are unchanged

- [ ] R-3: The tile routes through the SHIPPED `onOpenFeature` → `openApp` → `createAppOpener`
      path (no new window-dedup logic); re-invoke focuses/restores the same window. Reference
      `.opencode/tests/launcher/regression.md` R-3/R-8 and `.opencode/tests/window-manager/`.
  - **Edge:** presentation default stays `same-window` (no per-app default override added).

## R-4 — Settings → Fredo Setup is not regressed

- [ ] R-4: The Settings nav id `plugin-setup` (label `Fredo Setup`) still renders `<SetupWizard/>`
      — the SettingsSurface suites that mock `SetupWizard` and assert the `plugin-setup` nav item
      must remain green, unmodified.
  - **Edge:** light + dark; section switch back and forth.

## R-5 — Boot path integrity (effect deletion must not break other boot work)

- [ ] R-5: After the effect removal, Home's remaining boot effects still run: feature registration,
      zone-layout hydration, presentation hydration; Mission Monitor renders live sessions on boot
      (F-7c). No dangling 1200 ms timer, console clean. Reference `.opencode/tests/window-manager/`
      F-38 and `.opencode/tests/desktop-shell/`.
  - **Edge:** re-render loop absent (`Maximum update depth exceeded` = 0).
