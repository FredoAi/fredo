# postgres-cutover — Regression

> "Must not change" baseline for the **default PostgreSQL cutover + SQLite-path removal** domain
> (slice 6 of 6, issue **#2979**). These invariants MUST hold after the slice — any FAIL is a
> regression. Run on every testing phase that touches the default engine, the cutover/backout, the
> engine seam, or the persistence dependency graph.

> **Verification policy: live** — the cutover/backout/removal invariants are only observable on a
> running app; the Tester's Evidence MUST reference a PostgreSQL store read (managed `psql`), a
> `telemetry_spans` read, the restored snapshot, or `migration_status`/`storage_engine_status`. A
> static-only PASS is a FALSE PASS (except R-6/R-7, which are static scans that must be paired with
> a live PG-only boot).

> **G-284 substitution disclosed:** the `telemetry-query` skill is SQLite-only and cannot read the
> migrated PG store; live PG reads use the managed `psql` + the URI from `pg_supervisor_status` +
> `postgres.password` via `run-exitcode.ps1`.

> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `.opencode/scripts/dev-env.ps1 -Action Up -Spec 2979` / `-Action Down`; never an unbounded run;
> never a bare `postgres`/`pg_ctl`. The named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (the RTDB row-pipeline contract is unchanged):** `infrastructure/rtdb/*` classifier /
  merge / flush / query semantics and the row wire types (`RowDelivery` / `RowDeliveryBatch`) are
  unchanged; emission remains ONLY via `EventBus.emit_row_delivery_batch`; `useEventRows` merge
  semantics unchanged. The cutover/removal is not a pipeline rewrite.
  **Edge / FAIL:** a row-pipeline semantic hunk, a new event type/payload field, or a direct emit.

- [ ] **R-2 (`telemetry_spans` stays strictly READ-ONLY):** the cutover export and the canonical
  backfill never write `telemetry_spans` (or `telemetry_logs`/`telemetry_metrics`); the read path
  acquires a read-only handle/tx.
  **Edge / FAIL:** a write reaching `telemetry_spans`, or a read path that requires write perms.

- [ ] **R-3 (`fredo.db` is never mutated or deleted by the migration leg):** across the export +
  parity leg the source `fredo.db` is opened read-only and stays byte-identical (size + mtime +
  SHA-256); only an explicit, operator-invoked backout restores the snapshot over it.
  **Edge / FAIL:** any byte change during the migration leg; a deleted/renamed source.

- [ ] **R-4 (one-shot / idempotent, marker-gated):** the cutover leg runs at most once — gated by
  `migration.postgres.completed`; a second startup after a successful cutover skips it; a re-run is
  idempotent (no duplicate rows, no partial-state corruption).
  **Edge / FAIL:** a second copy on restart; a re-run that duplicates rows or re-gates parity.

- [ ] **R-5 (fail-closed — no engine flip on a parity failure):** on ANY count/checksum mismatch the
  marker is not set, the engine stays SQLite, `fredo.db` is untouched, and the app remains fully
  operational on SQLite.
  **Edge / FAIL:** an engine flip despite a mismatch; a set marker on a failure; a crash instead of
  a structured non-fatal error.

- [ ] **R-6 (no SQLite-only construct in migrated paths):** no `PRAGMA`, `sqlite_master`,
  `pragma_table_info`, or `?n` placeholder remains in a migrated path; `to_regclass` /
  `information_schema` / `$n` are used instead.
  **Edge / FAIL:** a residual construct in a migrated path (a comment/doc mention or a non-migrated
  store is not a FAIL). Static scan paired with a live PG-only boot (R-8).

- [ ] **R-7 (`rusqlite` absent or justified):** `rusqlite` is dropped from the app dependency graph,
  or every remaining site is explicitly named and justified.
  **Edge / FAIL:** a silent transitive retention.

- [ ] **R-8 (build gates):** `cargo check --locked` zero warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green (Windows-first) after
  `rusqlite` is dropped; no `#[allow(...)]`. If the UI is touched, `pnpm --filter @fredo/ui build`
  exits 0.
  **Edge / FAIL:** `cargo check` green but clippy red (check alone does NOT clear the clippy gate).

- [ ] **R-9 (no unbounded run / no orphan postmaster — G-263):** no new code path introduces an
  unbounded/blocking wait; the bounded stop + watchdog + fallback + sweep layers still hold; after
  every live leg's `-Action Down` no `postgres.exe` survives with no owning app.
  **Edge / FAIL:** an await without a finite bound; an orphan `postgres.exe` after teardown.

- [ ] **R-10 (no user-visible persistence regression):** on the PostgreSQL-default build, the app
  behaves identically to the pre-cutover SQLite build for the user — same read/write results, same
  Mission Monitor rendering, no new prompt/error/dialog.
  **Edge / FAIL:** any user-visible change beyond the engine swap.

- [ ] **R-11 (no dead dual path):** no unreachable fallback extraction and no dead `if engine ==
  sqlite` branch remains; the single extraction path (`rtdb/attrs.rs`) is the only one.
  **Edge / FAIL:** a dead branch or an unused fallback helper retained.

- [ ] **R-12 (real-corpus boundedness — G-286):** the real-corpus migration leg is bounded PER TABLE;
  a fixed whole-leg bound is the slice-4 round-3 failure class and must not be reintroduced.
  **Edge / FAIL:** a fixed whole-leg bound that fails on ~10.99M `telemetry_metrics` rows.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-13:** inherit and run `.opencode/tests/postgres-stores/regression.md` — the store + pool +
  RTDB preservation contract this cutover/removal must not disturb.
- [ ] **R-14:** inherit and run `.opencode/tests/postgres-migration/regression.md` — the one-shot
  data-migration + parity + backout invariants.
- [ ] **R-15:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the supervisor
  the default engine runs under.
- [ ] **R-16:** inherit and run `.opencode/tests/postgres-packaging/regression.md` — the acquisition
  / integrity / footprint surface the default engine depends on.
- [ ] **R-17:** inherit and run `.opencode/tests/mission-monitor/regression.md` (incl. the
  dual-provider rendering mandate) — the Mission Monitor surface the migrated data must serve.
- [ ] **R-18:** inherit and run `.opencode/tests/event-persistence/` and
  `.opencode/tests/realtime-data/` regression legs (when present) — the RTDB row-pipeline /
  feature-data surface.

## Notes

- This suite is reusable across any later persistence-engine change. Slice 6 (#2979) makes embedded
  PostgreSQL the default and removes the SQLite persistence path; any later slice touching the
  default engine, the cutover/backout, or the persistence dependency graph inherits R-1..R-12.
