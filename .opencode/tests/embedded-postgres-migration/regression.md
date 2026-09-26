# embedded-postgres-migration — Regression

Feature: local persistence (embedded SQLite `fredo.db`, RTDB row store, observability
`sqlx`). Issue #2964 is a **spike** whose migration approach must have ZERO production
impact. This suite's regression here is the "must not change" baseline plus linked suites
whose surface overlaps persistence.

> The spike's only permitted changes are additive research/evidence artifacts (a design doc
> under `docs/research/2964-postgres-migration-approach.md` and, optionally, an isolated
> `spikes/2964-postgres-migration/` crate). Any deviation is a regression FAIL.

## No-change baseline

- [ ] **R-1: `fredo.db` persistence path untouched.**
  `infrastructure/storage/*` and any `fredo.db` schema/migration code are byte-identical to
  `main` (diff shows no hunks).
  **FAIL:** any hunk (even formatting-only) in that surface.

- [ ] **R-2: RTDB row-pipeline contract unchanged.**
  `infrastructure/rtdb/*` and the row wire types (`RowDelivery`/`RowDeliveryBatch`) are
  unchanged; classifier/merge/flush/query behavior is byte-identical.
  **FAIL:** any row-pipeline hunk or new event type/payload field.

- [ ] **R-3: feature-data store untouched.**
  `infrastructure/feature_data/*` and FeatureStore `feature_*` table definitions are
  unchanged.
  **FAIL:** any hunk in that surface.

- [ ] **R-4: observability `sqlx` untouched.**
  `telemetry_spans` and observability `sqlx` code/paths are unchanged (the backfill path is
  strictly READ-ONLY to `telemetry_spans`; the spike must not alter it).
  **FAIL:** any hunk in that surface or a dependency/query change in the observability path.

- [ ] **R-5: any PoC is isolated from production.**
  A PoC crate is NOT a member of the production Cargo workspace; its dependency is NOT added
  to `apps/tauri/src-tauri/Cargo.toml`; it is never referenced by `lib.rs`/`AppRuntime`.
  **FAIL:** workspace-member addition, dependency leak, runtime wiring, or CI
  (`.github/workflows/**`) reference.

- [ ] **R-6: builds stay green.**
  `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml` → zero errors, zero
  warnings; `pnpm --filter @fredo/ui build` → exit 0, zero TypeScript errors.
  **FAIL:** any error or warning.

- [ ] **R-7: prior #2948 artifacts unmodified.**
  `spikes/2948-embedded-postgres/**` and `docs/research/2948-embedded-postgres-spike.md` are
  byte-identical to `main` (the spike is evidence input, not a target for revision).
  **FAIL:** any hunk under those paths.

## Linked suites (overlapping surface)

- [ ] **R-8: inherit and run `.opencode/tests/persistence-spike/regression.md`** (R-1..R-5)
  unchanged — the #2948 spike baseline for this exact persistence surface. The new spike
  must not alter any behavior that suite covers.
- [ ] **R-9: re-run `.opencode/tests/event-persistence/` and `.opencode/tests/rtdb/**`
  regression legs if/when present** — the RTDB row-pipeline surface whose storage engine this
  migration will eventually replace. A spike must change none of it.

## Notes

- This suite is reusable: the follow-up implementation spec that actually cuts `fredo.db`
  over to PostgreSQL inherits and extends R-1..R-7 (they become true runtime regression
  invariants, not spike-only checks). At that point R-1..R-4 are expected to be re-scoped
  deliberately — the spike itself must keep them green.
