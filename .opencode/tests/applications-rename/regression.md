# Applications Rename — Regression

> The "must not change" baseline for the `feature` → `application` rename (#2956). The rename is a
> structural refactor with **zero intended behavior change**; every invariant below is a hard
> non-goal from the Architect's plan. Run these alongside the overlapping feature suites listed at
> the bottom. **Verification policy: live** (F-5/F-6/F-7/F-8 live legs also run the overlapping
> suites' live rows).

## Must-not-change invariants

- [ ] **R-1 — Fredo app composition unchanged.** `showable` filtering, `dedupeByApplicationId`
  ordering, the `allApplications` barrel-glob semantics, and `registerApplication` registration are
  behaviorally identical; the same tile set renders as before the rename; no cross-app imports
  introduced. (Ref: `apps/ui/src/applications/allApplications.ts`,
  `applicationRegistry.ts`, `Home.tsx`.)

- [ ] **R-2 — Launcher geometry + open path unchanged.** The launcher keep-out geometry, tile
  keyboard navigation, window-opener wiring (`onOpenFeature` → own-kernel `openWindow`), open-apps
  row, and the collapsed-on-open behavior are unchanged; the only delta is copy.

- [ ] **R-3 — Hotkey resolution unchanged.** App-scoped hotkey registration/resolution behaves
  identically; only the displayed tier label string changes.

- [ ] **R-4 — RTDB data-layer semantics unchanged.** The envelope SHAPE and discrimination order
  (checked BEFORE the RTDB validators in `AppProvider`), the spread-merge (`{...row, ...patch}`),
  the seq-guarded stale-patch drop, retention/tombstone behavior, and watch scoping are unchanged;
  only the discriminator (`applicationBatch`) + id field (`applicationId`) + command names change.

- [ ] **R-5 — Rust command arg/result shapes unchanged.** `application_data_*` /
  `application_store_*` accept the same args and return the same result shapes as the pre-rename
  `feature_*` commands; namespace validation, retention/projection semantics, and the frozen
  on-disk identifiers are untouched.

- [ ] **R-6 — Pre-existing app vocabulary RETAINED (no second churn wave, no duplicated concept).**
  `AppStore` (KV control plane), `infrastructure/app_open.rs`, `appWindows.ts`,
  `appPresentationStore.ts`, the `app-<id>` window label + `?view=app&id=` route,
  `fredo open-app` / `app-open-request`, Settings → **Apps**, and `app_window_presentation` are
  unchanged. The rename collapses `feature*` → `application*`; it does not add a competing spelling.

- [ ] **R-7 — Frozen on-disk identifiers unchanged.** `feature_data_tables`,
  `feature_data_tombstones`, `feature_terminal_sessions`, prefix `feature_{sanitizedId}_{table}`,
  column `feature_id`, and the migration fixtures
  (`tests/support/migration_fixture.rs`, `tests/postgres_migration.rs`, `tests/storage_engine_pg.rs`)
  stay on the shipped literals. No destructive PG migration runs against an existing install.

- [ ] **R-8 — Retained different-sense uses unchanged.** Optimizely `'Feature Flags'` display name
  + feature-flag copy; ADO work-item type `'Feature'`; MIME `application/json`; Cargo/build
  `feature=`; `.opencode/**` + `docs/agentic-pipeline/**` pipeline-meta.

- [ ] **R-9 — Build/test gates unchanged green.** `cargo check --locked` (zero warnings), clippy
  `-D warnings`, `pnpm --filter @fredo/ui build`, `pnpm --filter @fredo/ui test:run`, and
  `pnpm --filter @fredo/tauri build:webview` all pass; console clean of
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## Overlapping suites to re-run (inherited regression assets)

- `.opencode/tests/launcher/` — tile set, geometry, keyboard nav, open path, open-apps row.
- `.opencode/tests/realtime-data/` — the feature-owned read/watch layer (commands, `featureBatch`
  shape, spread-merge/seq semantics, isolation).
- `.opencode/tests/fredo-cli/` — `fredo open-app` help/exit codes/fallback (F-1..F-5).
- `.opencode/tests/postgres-stores/` — frozen `feature_*` identifiers, declared-table round trips,
  Mission Monitor PG boot.
- `.opencode/tests/mission-monitor/` — live session render + `telemetry_spans` cross-check.
- `.opencode/tests/settings/` — settings grouping/nav (Applications group).
- `.opencode/tests/hotkeys/` — hotkey tier label + resolution.

Any change to a listed "must-not-change" behavior = **FAIL** (the rename is name-only).
