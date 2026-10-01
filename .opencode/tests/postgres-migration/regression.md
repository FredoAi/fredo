# postgres-migration — Regression

> "Must not change" baseline for the **one-shot `fredo.db` → PostgreSQL data migration** domain
> (slice 4 of 6, issue **#2977**). These invariants MUST hold after the slice — any FAIL is a
> regression. Run on every testing phase that touches the data migration, the engine seam, the
> data store, or the Mission Monitor rendering path.

> **Verification policy: live** — the store/rollback/row-pipeline invariants are only observable on
> a running app; the Tester's Evidence MUST reference a PostgreSQL store read (managed `psql`), a
> `telemetry_spans` read, or the restored snapshot. A static-only PASS is a FALSE PASS.

> **G-284 substitution disclosed:** the `telemetry-query` skill is SQLite-only and cannot read the
> migrated PG store; live PG reads use the managed `psql` + the URI from `pg_supervisor_status` +
> `postgres.password`.

> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `.opencode/scripts/dev-env.ps1 -Action Up -Spec 2977` / `-Action Down`; never an unbounded run;
> never a bare `postgres`/`pg_ctl`. The named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (the migration never mutates or deletes `fredo.db`):** across the export + parity leg
  the source `fredo.db` is opened read-only and stays byte-identical (size + mtime + SHA-256);
  the migration never deletes or replaces it. Only an explicit, operator-invoked backout restores
  the snapshot over it.
  **Edge / FAIL:** any byte change to `fredo.db` during the migration leg; a deleted/renamed source;
  a migration that "helpfully" rewrites the source.

- [ ] **R-2 (`telemetry_spans` stays strictly READ-ONLY):** the migration export and the canonical
  backfill never write `telemetry_spans` (or `telemetry_logs`/`telemetry_metrics`); the read path
  acquires a read-only handle/tx.
  **Edge / FAIL:** a write reaching `telemetry_spans`, or a read path that requires write perms.

- [ ] **R-3 (one-shot / idempotent, marker-gated):** the export runs at most once — gated by
  `migration.postgres.completed`; a second startup after a successful cutover skips it; a re-run is
  idempotent (no duplicate rows, no partial-state corruption).
  **Edge / FAIL:** a second copy on restart; a re-run that duplicates rows or re-gates parity.

- [ ] **R-4 (fail-closed — no engine flip on a parity failure):** on ANY count/checksum mismatch
  the marker is not set, the engine stays SQLite, `fredo.db` is untouched, and the app remains
  fully operational on SQLite.
  **Edge / FAIL:** an engine flip despite a mismatch; a set marker on a failure; a crash instead of
  a structured non-fatal error.

- [ ] **R-5 (store behaviour unchanged post-cutover):** after a successful cutover every migrated
  store (`AppStore` KV, `FeatureStore` `feature_*`, `FeatureDataStore` +
  `feature_data_tables`/`feature_data_tombstones`, `RtdbStore` `chat_rows`/`tool_use_rows`/
  `agent_session_rows`, `SpanStore` `telemetry_*`) serves from the ONE shared PostgreSQL pool with
  the slice-2/slice-3 semantics unchanged.
  **Edge / FAIL:** a store still reading SQLite after the flip; a per-store connection.

- [ ] **R-6 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types (`RowDelivery` / `RowDeliveryBatch`) are
  unchanged; emission remains ONLY via `EventBus.emit_row_delivery_batch`; `useEventRows` merge
  semantics unchanged. The migration is a data move, never a pipeline rewrite.
  **Edge / FAIL:** a row-pipeline semantic hunk, a new event type/payload field, or a direct emit.

- [ ] **R-7 (markers carried verbatim):** `rtdb.backfill.completed`, the provider `.v2` marker, and
  each per-table `feature_data_tables.backfill_done` keep their carried-verbatim semantics — never
  re-derived or reformatted by the migration.
  **Edge / FAIL:** a re-derived/reformatted marker, or a marker dropped in the copy.

- [ ] **R-8 (build gates):** `cargo check --locked` zero warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green (Windows-first); no
  `#[allow(...)]`. If UI is touched, `pnpm --filter @fredo/ui build` exits 0.
  **Edge / FAIL:** `cargo check` green but clippy red (check alone does NOT clear the clippy gate).

- [ ] **R-9 (no unbounded run / no orphan postmaster — G-263):** no new code path introduces an
  unbounded/blocking wait; the slice-1 bounded stop + watchdog + fallback + sweep layers still
  hold; after every live leg's `-Action Down` no `postgres.exe` survives with no owning app.
  **Edge / FAIL:** an await without a finite bound; an orphan `postgres.exe` after teardown (the
  #2948 ~11 h `pg.stop()` hang class).

## Linked suites (overlapping surface — run alongside)

- [ ] **R-10:** inherit and run `.opencode/tests/postgres-stores/regression.md` (R-1..R-28) — the
  store + pool + RTDB preservation contract this data move must not disturb.
- [ ] **R-11:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` (R-1..R-12) —
  the supervisor the migration runs under.
- [ ] **R-12:** inherit and run `.opencode/tests/embedded-postgres-migration/regression.md` — the
  spike-era "no production impact" baseline whose R-1..R-7 are re-scoped here into true runtime
  invariants.
- [ ] **R-13:** inherit and run `.opencode/tests/mission-monitor/regression.md` (incl. R-62, the
  dual-provider rendering mandate) — the Mission Monitor surface the migrated data must serve.
- [ ] **R-14:** inherit and run `.opencode/tests/event-persistence/` and
  `.opencode/tests/realtime-data/` regression legs (when present) — the RTDB row-pipeline /
  feature-data surface.
- [ ] **R-15:** inherit and run `.opencode/tests/copilot-capture/` regression legs — the Copilot
  split-turn producer the F-12 Mission Monitor mandate consumes.

## Notes

- This suite is reusable across the remaining Postgres slices (4–6). Slice 4 (#2977) moves the
  existing DATA with a per-table parity gate + executable SQLite rollback; slice 6 (#2979) blocks
  on this one. Any later slice that touches the data store or the engine seam inherits R-1..R-9.
