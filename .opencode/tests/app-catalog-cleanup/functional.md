# app-catalog-cleanup — Functional

Per-requirement cases for Issue #3055 (remove the **Query Viewer** and **Stepper Probe** applications and every reference to them). Verification policy: **live** — REQ-1 and REQ-5 observe the running app.

- [x] F-1 (AC1): Neither app appears in any user-facing or programmatic surface. Drive the running app (dev-env Up): open the launcher (`Ctrl+Space`) and read the APPS grid; open Settings → Apps; read the frontend `getApplications()` list; invoke companion `open_app` naming each removed app; run `fredo open-app "Query Viewer"` and `fredo open-app "Stepper Probe"`.
  Expected: no tile/row/testid for `query-viewer` or `stepper-probe` in the launcher grid (Home.tsx:26) or Settings → Apps (`AppPresentationSettings.tsx:225`); neither id in `getApplications()` (`applicationRegistry.ts:28`); companion/CLI resolve neither (see F-5).
  Edge: display-name partials ("Viewer"/"Probe") do not resolve (`appNameMatches` launcherEnterAction.ts:113; `resolveAppIdentity` appIdentity.ts:101); after removing the example tiles every surviving tile is still keyboard-reachable with no nav gap/ghost tile (`featureRegistry.dedupe.test.tsx:293-297`).

- [x] F-2 (AC2): Both application directories are gone and nothing imports/registers them. `Test-Path apps/ui/src/applications/query-viewer` and `.../stepper-probe`; recursive, case-insensitive grep `query-viewer|stepper-probe|QueryViewer|StepperProbe` across `apps/`.
  Expected: both `Test-Path` → False (query-viewer had 4 entries, stepper-probe 2); 0 source imports/registrations; `allApplications.ts:5` glob `./*/index.ts` unchanged.
  Edge: positive control — `getApplications()` is still non-empty (surviving apps auto-discovered through `import.meta.glob`); a bare-tool-name comment left behind is informational, not an AC failure (cf. `window-engine-cleanup` E-1).

- [x] F-3 (AC3): CI-parity build is green. `pnpm --filter @fredo/ui build`; then `cargo check --locked`, `cargo test --locked`, `cargo clippy --locked -- -D warnings`.
  Expected: UI build exits 0 (tsc + vite), no unresolved-module error; cargo check/test/clippy all exit 0 with zero warnings.
  Edge: `cargo check` alone does NOT clear the clippy gate — clippy `-D warnings` is binding; the re-pointed backend test `app_window.rs:328` must compile and pass.

- [x] F-4 (AC4): No live doc/comment presents either app as existing. Grep `docs/` and source comments.
  Expected: `ARCHITECTURE.md:535,590,698`, `FAQ.md:36`, `FredoApplicationClass.ts:9`, `featureResponseApi.ts:17` re-pointed to a surviving/neutral app; `FredoApplicationClass.ts:137` ("stepper probe's auto-navigation") re-pointed; the `isMultiWindow` capability (`FredoApplicationClass.ts:99`) is UNCHANGED.
  Edge: re-point (do not delete) the multi-instance example so the capability stays documented; `docs/CLI_GUIDE.md` carries no removal-app name (grep → 0) but must remain internally consistent; `docs/archive/browser-extension/*` and historical `.opencode/tests/**` records are OUT of scope.

- [x] F-5 (AC5): An open request naming a removed app is treated as unknown. Against the running app run `fredo open-app "Query Viewer"`, `fredo open-app "Stepper Probe"`, `fredo open-app "stepper-probe"`; and companion `open_app` with each.
  Expected: deterministic unknown — nothing opens; CLI `outcome:"unknown"` + non-zero exit (`app_open.rs:53-62,254,361`); companion replies `I couldn't find "<name>"` (`appOpenReply.ts`; FAQ.md:272); no error dialog, no blank/ghost window.
  Edge (non-AC, unit pin): unknown/failure mapping is covered by `app_open.rs:616-648` and `useAppOpenRequests.test.ts:116,152`. Edge (non-AC): the id forms `"query-viewer"` / `"stepper-probe"` must also be unknown.

## Results (run 2026-10-13, spec/3055 @ 5bb52bf)

- **F-1 PASS** — launcher grid `#fredo-launcher-grid` = 5 tiles `[PostgreSQL, Mission Monitor, Fredo Setup, Settings, Terminal]`; Settings → Apps = 5 rows; live `getApplications()` = 15 apps, none `query-viewer`/`stepper-probe`; companion + `fredo open-app` resolve neither.
- **F-2 PASS** — both dirs `Test-Path` False; case-insensitive `apps/` token grep = 0; glob unchanged.
- **F-3 PASS** — UI build 0 TS errors; `cargo check`/`clippy -D warnings` 0 warnings; `cargo test --lib` 1343 passed; UI suite 213 files / 2689 tests passed.
- **F-4 PASS** — every cited doc/comment re-pointed; `isMultiWindow` unchanged; `docs/` matches only out-of-scope `archive/browser-extension` + `references.md`.
- **F-5 PASS** — CLI 8 name/id forms → `{"outcome":"unknown"}` exit 1; companion typed ask → model selected `open_app`, reply `I couldn't find "…"`; 0 windows opened.
