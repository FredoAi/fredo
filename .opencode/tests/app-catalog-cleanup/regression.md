# app-catalog-cleanup — Regression

"No-change" baseline for Issue #3055 (remove Query Viewer + Stepper Probe). Removal-only slice — every surviving app, the launcher, Settings → Apps, the window kernel, and the open-app transport must behave exactly as before.

- [x] R-1: Launcher grid unchanged for surviving apps. `getApplications()` → `dedupeByApplicationId(...).filter(showable)` renders one tile per surviving app, index-aligned (`applicationRegistry.ts:47`). Expected: keyboard nav (ArrowLeft/Right) lands on real tiles with no gap/ghost tile after the example tiles are removed.
- [x] R-2: Settings → Apps unchanged for surviving apps. `AppPresentationSettings.tsx:225` lists surviving `showable` apps; the multi-window note/radio lockout for a surviving multi-window app is unchanged. Expected: no empty/undefined row produced by the deleted ids.
- [x] R-3: Window kernel + presentation unchanged. The `isMultiWindow` capability (`FredoApplicationClass.ts:99`) and its consumers are re-pointed only. `apps/ui/src/shared/window-system/__tests__/appWindows.test.ts` and `appPresentationStore.test.ts` pass after fixture re-point to a surviving/neutral id (`app_window_label("mission-monitor")` → `app-mission-monitor`, `app_window.rs:329`).
- [x] R-4: Open-app transport unchanged. `fredo open-app` and companion `open_app` still resolve a SURVIVING app (e.g. `fredo open-app "Mission Monitor"` → `outcome:"opened"`). Expected: parity per `ARCHITECTURE.md:791-792`; the removal touches only unresolvable names.
- [x] R-5: Docs remain internally consistent. Cross-links from FAQ / CLI Guide to the app catalog still resolve and the `isMultiWindow` documentation is intact. Expected: no dangling "Query Viewer"/"Stepper Probe" reference and no broken capability doc.

Overlaps: `launcher` (grid + open-apps row), `settings` (Settings → Apps), `window-manager` (window presentation), `fredo-cli` (open-app transport), `applications-rename` (app-catalog naming). Run their `regression.md` if the diff touches their surface.

## Results (run 2026-10-13, spec/3055 @ 5bb52bf)

- **R-1 PASS** — `#fredo-launcher-grid` = one real tile per surviving showable app (`[PostgreSQL, Mission Monitor, Fredo Setup, Settings, Terminal]`); arrow-nav selection always lands on a real tile, no gap/ghost (removed-app filtered queries render the "No apps available" empty state, not a ghost tile).
- **R-2 PASS** — Settings → Apps lists the 5 surviving `showable` apps with working Main window/Own window radios; no empty/undefined row.
- **R-3 PASS** — `isMultiWindow` capability retained; `appWindows.test.ts` + `appPresentationStore.test.ts` green in the 2689-test UI suite; `app_window_label("mission-monitor")` → `app-mission-monitor` (`cargo test --lib`).
- **R-4 PASS** — `fredo open-app 'Mission Monitor'` → `{"outcome":"opened","displayName":"Mission Monitor"}` exit 0; Mission Monitor opened in-window (main window).
- **R-5 PASS** — FAQ / ARCHITECTURE cross-links intact; `isMultiWindow` capability doc retained; no dangling removed-app reference.
- **R-5 note** — `docs/CLI_GUIDE.md` carries no removed-app token (grep → 0), unchanged.
