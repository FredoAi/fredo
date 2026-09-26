# persistence-spike — Regression

Feature: local persistence (embedded SQLite / `fredo.db`, RTDB row store, observability
`sqlx`). Issue #2948 is a **spike** that must have ZERO production impact. Regression here
is the negative-case baseline (AC5) plus linked suites whose surface overlaps persistence.

> The spike's only permitted change is additive research/evidence artifacts (e.g. an
> isolated `spikes/embedded-pg-poc/` crate). Any deviation is a regression FAIL.

## No-change baseline (AC5)

- [ ] **R-1: `fredo.db` persistence path untouched.**
  `infrastructure/storage/*` and any `fredo.db` schema/migration code are byte-identical
  to `main` (diff shows no hunks).
  **Expected:** no changed files under the fredo.db/SQLite persistence surface.
  **FAIL:** any hunk (even formatting) in that surface.

- [ ] **R-2: RTDB row-pipeline contract unchanged.**
  `infrastructure/rtdb/*` and the row wire types (`RowDelivery`/`RowDeliveryBatch`) are
  unchanged; the classifier/merge/flush/query behavior is byte-identical.
  **Expected:** diff clean on the row-pipeline surface; no new event type or payload field.
  **FAIL:** any row-pipeline hunk.

- [ ] **R-3: observability `sqlx` untouched.**
  `telemetry_spans` and observability `sqlx` code/paths are unchanged.
  **Expected:** diff clean; no dependency or query change in the observability path.
  **FAIL:** any hunk in that surface.

- [ ] **R-4: PoC is isolated from production.**
  The spike crate is NOT a member of the production Cargo workspace and its dependency is
  NOT added to `apps/tauri/Cargo.toml`; it is never referenced by `lib.rs`/`AppRuntime`.
  **Expected:** `cargo check` builds only the existing production crates unchanged.
  **FAIL:** workspace-member addition, dependency leak, or runtime wiring.

- [ ] **R-5: builds stay green.**
  `cargo check` (`apps/tauri/src-tauri`) → zero errors, zero warnings;
  `pnpm --filter @fredo/ui build` → exit 0, zero TypeScript errors.
  **Expected:** both commands succeed exactly as on `main`.
  **FAIL:** any error or warning.

## Linked suites (overlapping surface)

- [ ] **R-6: inherit and run the `rtdb` row-pipeline regression suite** if/when a
  `.opencode/tests/rtdb/` suite exists (this is the primary overlapping durable domain).
  Run it unchanged; a spike must not alter any row behavior it covers.

## Notes

- This suite is reusable: any future spec that touches local persistence
  (`infrastructure/storage/`, `infrastructure/rtdb/`, `fredo.db`) runs it and extends it —
  at that point R-1..R-5 become true regression invariants, not spike-only checks.
