# postgres-cutover — Functional

Durable functional suite for the **default PostgreSQL cutover + SQLite-path removal** feature
domain (slice 6 of 6, issue **#2979**). Builds on slices 1–5: `postgres-lifecycle` #2974,
`postgres-stores` #2975/#2976, `postgres-migration` #2977, `postgres-packaging` #2978. This slice
makes embedded PostgreSQL the DEFAULT and removes the SQLite persistence path for the migrated
stores, after a production cutover is parity-checked and a real backout is exercised.

> **Evidence policy: LIVE.** The default-cutover, rollback, removal, and Mission Monitor rows are
> provable ONLY by observing a running artifact — their Evidence MUST reference a PostgreSQL store
> read (managed `psql`), a `telemetry_spans` read, the restored snapshot, or a `migration_status` /
> `storage_engine_status` / `pg_supervisor_status` read. A static-only PASS is a FALSE PASS.

> **G-284 PG read lever (disclosed substitution).** The `telemetry-query` skill is SQLite-only and
> CANNOT read the migrated PostgreSQL store. For every live PG read use the managed `psql`
> (`%APPDATA%\com.fredo.app\postgres-install\18.6.0\bin\psql.exe`) with the connection URI built
> from `pg_supervisor_status` (`{state, port, pid, dataDir}`) + the `postgres.password` AppStore key,
> database `postgres`, invoked through the allowlisted wrapper
> `run-exitcode.ps1 -Command "<psql> <uri> ..."`. The SQLite-only `telemetry-query` skill is the
> correct lever ONLY for the SOURCE `fredo.db` read.

> **G-263 SAFETY (named failure mode: the #2948 ~11 h `pg.stop()` hang).** Every live leg
> starts/stops through the sanctioned lever
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2979` / `-Action Down`
> (kill-never-wait on expiry; `-EnvVar NAME=value` for env seams); never a bare `postgres`/`pg_ctl`.
> An observed unbounded/blocking wait is a FAIL, not a skip.

> **G-286 bounded runtime.** The real corpus is ~10.99M `telemetry_metrics` rows. The real-corpus
> migration leg MUST be bounded PER TABLE (the slice-4 round-3 failure was a fixed whole-leg bound).
> Never run an unbounded binary.

> **Induction levers (G-275) — binding names (G-255).** `FREDO_DATA_DIR` (app-data-dir override →
> the in-repo fixture dir under `.opencode/tmp/2979/`), `FREDO_PG_DATA_DIR` (writable PG data dir),
> `FREDO_MIGRATION_FORCE_MISMATCH` (∈ {`<table>`, `1`/`true`, `<table>:export_error`,
> `snapshot_fail`}), `FREDO_STORAGE_ENGINE` (`sqlite`/`postgres`). Adopt the Architect's published
> names verbatim.

> **BEFORE leg (G-223/G-283).** For any before→after row use
> `dev-env.ps1 -Action Up -Spec 2979 -At <pre-change-tip>` (restore per G-163); never pin to a bare
> `main` path a later commit can delete.

> **G-271 coverage.** Where a row verifies a structured deliverable (the migrated-store set, the
> SQLite-construct set, the retained-dependency set), assert COVERAGE of the named elements — never
> a literal count the requirement does not state.

## Cases

- [ ] **F-1 (REQ-1, AC1) — fresh install boots on PostgreSQL with NO migration leg.**
  Boot with a fresh `FREDO_DATA_DIR` (no `fredo.db`) and a fresh `FREDO_PG_DATA_DIR`; read
  `storage_engine_status` + `migration_status`; managed-`psql` read `settings`.
  **Expected:** `storage_engine_status.engine == "postgres"`; the startup performs NO cutover leg;
  the store read succeeds. **FAIL** = an engine other than postgres, or a cutover leg run on a
  fresh install.

- [ ] **F-2 (REQ-2, AC1) — an upgraded install cuts over once, gated by
  `migration.postgres.completed`; a second startup skips.**
  Boot with a fixture `fredo.db` (`FREDO_DATA_DIR`) and a fresh `FREDO_PG_DATA_DIR`; observe the
  cutover; restart over the same PG data dir.
  **Expected:** the marker `migration.postgres.completed` is set; `migration_status=Completed`; the
  engine flips to postgres; per-table count+checksum parity matched; the second startup reports the
  leg `Skipped` (no re-copy, no parity re-gate). **FAIL** = a second copy, a flip back to SQLite, or
  a set marker with no data.

- [ ] **F-3 (REQ-3, AC1, G-275) — a forced parity mismatch fails closed: no marker, no flip,
  `fredo.db` untouched, next startup re-runs the idempotent export.**
  Induce via `FREDO_MIGRATION_FORCE_MISMATCH=<table>` (or `1`) on a fixture under
  `.opencode/tmp/2979/`; record `fredo.db` SHA-256 before.
  **Expected:** `migration.postgres.completed` is NOT set; `storage_engine_status.engine ==
  "sqlite"`; `fredo.db` byte-identical; the app is fully operational on SQLite; the next startup
  re-runs the read-only export (idempotent, no partial-state corruption). **FAIL** = a set marker,
  an engine flip, a mutated `fredo.db`, a crash, or an unbounded wait.

- [ ] **F-4 (REQ-4, AC4) — an install that never had `fredo.db` starts clean on PostgreSQL with no
  migration leg.**
  Fresh `FREDO_DATA_DIR` + fresh `FREDO_PG_DATA_DIR`; boot; read the marker + `migration_status`.
  **Expected:** no migration leg runs; no `migration.postgres.completed` set; empty-store reads
  succeed (no error, no empty-string sentinel). **FAIL** = a marker set on a clean start, or a
  migration leg attempted with no source.

- [ ] **F-5 (REQ-5, AC2) — the production rollback is exercised end-to-end and `rollback.verified`
  becomes true with data intact.**
  Take a real cutover (fixture or real corpus) with its pre-cutover snapshot; execute the backout
  (stop app → restore the snapshot over `fredo.db` → start the SQLite build); recompute per-table
  counts + SHA-256 checksums on the restored file and compare to the pre-cutover values; read
  `rollback.verified` from `settings` via managed `psql`.
  **Expected:** the restored counts/checksums EQUAL the pre-cutover values; the SQLite build boots
  and operates on the restored data; `rollback.verified == true`; the migration leg never mutated or
  deleted `fredo.db`. **FAIL** = a restored checksum that differs, a boot failure, a false
  `rollback.verified`, or any migration-leg mutation of `fredo.db`.

- [ ] **F-6 (REQ-6, AC3) — no SQLite branch in the migrated stores; the engine seam reduces to
  PostgreSQL.**
  Code-inspect the migrated stores + the engine seam; boot PG-only and exercise the seam live.
  **Expected:** no `sqlite` / `Engine::Sqlite` branch remains in the migrated stores
  (`AppStore`/`FeatureStore`/`FeatureDataStore`/`RtdbStore`/`SpanStore` + the read-only paths); the
  engine enum/seam is PostgreSQL-only; the live boot exercises it. **FAIL** = a residual SQLite
  branch, a `Mutex<Connection>` store handle, or a `sqlite` cfg/feature.

- [ ] **F-7 (REQ-7, AC3) — `rusqlite` dropped from the app dependency graph (or retained only where
  explicitly justified and named).**
  Run `cargo tree -i rusqlite` (or `cargo metadata`) for `apps/tauri/src-tauri`.
  **Expected:** `rusqlite` is absent from the app crate's dependency graph; OR every remaining site
  is named in the plan with a justification (e.g. a dev/test-only tool). **FAIL** = a silent
  transitive retention, or a build feature that still enables it.

- [ ] **F-8 (REQ-8, AC3) — no SQLite-only construct (`PRAGMA`, `sqlite_master`,
  `pragma_table_info`, `?n` placeholders) remains in migrated paths.**
  Source-scan the migrated modules for each named construct.
  **Expected:** none of the named constructs remains in a migrated path. **FAIL** = a residual
  construct in a migrated path (a comment/doc mention or a non-migrated store is not a FAIL).

- [ ] **F-9 (REQ-9, AC3) — no dead fallback extraction code; no dual path.**
  Inspect the extraction / fallback paths.
  **Expected:** no unreachable fallback extraction; no dead `if engine == sqlite` branch; the
  single extraction path (`rtdb/attrs.rs`) is the only one. **FAIL** = a dead branch or an unused
  fallback helper retained.

- [ ] **F-10 (REQ-10, AC4) — a downgrade to a pre-cutover build reads the retained, byte-identical
  `fredo.db`; the accepted post-cutover data-loss policy is documented.**
  After a cutover, start the pre-cutover build (BEFORE leg tip) against the retained `fredo.db`;
  compare SHA-256; locate the documented loss policy.
  **Expected:** `fredo.db` byte-identical to the pre-cutover source; the pre-cutover build boots and
  reads it; the accepted post-cutover data-loss policy is documented. **FAIL** = a mutated/missing
  `fredo.db`, a boot failure, or an absent policy.

- [ ] **F-11 (REQ-11, AC5) — no-regression: the existing suites pass on the PostgreSQL-only build
  and the slice 1–5 footprint/startup/latency results are re-confirmed at the release cut.**
  Run the inherited suites + re-measure footprint/startup/latency on the BEFORE and AFTER legs.
  **Expected:** `postgres-stores` / `postgres-migration` / `postgres-lifecycle` /
  `postgres-packaging` + `mission-monitor` suites green; a BEFORE|AFTER|Δ number table for
  footprint/startup/latency. **FAIL** = a red inherited suite, or a restated slice number with no
  re-measurement.

- [ ] **F-12 (REQ-12, MISSION-MONITOR E2E — HUMAN DIRECTIVE, G-256) — boot on the
  PostgreSQL-default path with REAL migrated data; Mission Monitor renders live sessions / tools /
  tokens / graph for BOTH OpenCode + Copilot at parity with the pre-cutover SQLite rendering; AND
  exercise the executable SQLite backout.**
  Capture a pre-cutover Mission Monitor baseline (DOM + screenshot + source rows). Cut over the real
  corpus; boot on the PostgreSQL-default path; drive a live OpenCode session through the **Terminal**
  feature (`write_pty_input` with a trailing `\r`) AND inject a Copilot split-turn session via the
  in-repo producer; open Mission Monitor; select each session at one instant; snapshot DOM +
  screenshot; read the migrated store via managed `psql` at the SAME instant. Then execute the
  SQLite backout (stop app → restore snapshot → start SQLite build) and confirm the restored
  checksums.
  **Expected:** both sessions listed as distinct entries; each renders chat node + `── USER ──` +
  `── TOOLS (N) ──` + RESPONSE + tokens + graph at parity with the pre-cutover baseline; the
  same-instant managed-`psql` read matches the render; the backout is executed and the restored
  checksums match the pre-cutover values. Modeled on `mission-monitor` F-54 /
  `postgres-migration` F-12. **FAIL** = a blank panel while migrated rows exist, a stale SQLite
  read, a single-provider receipt, a static-only receipt, or a backout that does not restore
  byte-exact.

- [ ] **F-13 (REQ-13, NFR) — bounded runtime + zero-warning build + Windows-first + `fredo.db`
  read-only.**
  Run the real-corpus cutover (bounded per table); run `cargo check --locked`,
  `cargo clippy --locked -- -D warnings`, `cargo test --locked`; check `fredo.db` bytes.
  **Expected:** the real-corpus leg is bounded PER TABLE and completes; zero warnings, clippy clean,
  tests green after `rusqlite` is dropped; Windows-first; `fredo.db` byte-unchanged across the
  migration leg. **FAIL** = a fixed whole-leg bound, an unbounded/blocking wait, check green but
  clippy red, or a mutated `fredo.db`.

## Non-functional

- [ ] **N-1 (bounded runtime, G-286):** the real-corpus copy is bounded per table; no fixed
  whole-leg bound (F-13).
- [ ] **N-2 (no orphan postmaster, G-263):** after `-Action Down` no `postgres.exe` survives with no
  owning app; every live leg finite (F-13).
- [ ] **N-3 (read-only artifact):** `fredo.db` retained read-only as the backout artifact;
  byte-unchanged across the migration leg (F-3/F-5/F-13).
- [ ] **N-4 (build hygiene):** F-13 green; `cargo check` alone does not clear the clippy gate.
- [ ] **N-5 (no row-pipeline regression):** the RTDB row-pipeline contract unchanged; Mission
  Monitor still renders from the store (F-12); emission remains ONLY via
  `EventBus.emit_row_delivery_batch`.

## Suite-level pass/fail

PASS = F-1..F-13 green with live evidence from the running artifact (PG store read via managed
`psql`; `telemetry_spans`; the restored snapshot; `migration_status`/`storage_engine_status`) and
N-1..N-5 holding. Any of: an engine flip or a set marker on a parity mismatch; a mutated/deleted
`fredo.db` on the migration leg; `rollback.verified` false while F-5 is claimed PASS; a residual
SQLite branch or SQLite-only construct in a migrated path; `rusqlite` still in the app graph without
a named justification; a blank Mission Monitor while migrated rows exist; a static-only receipt on a
live row; a fixed whole-leg bound on the real corpus; or an unbounded/blocking wait (the #2948
`pg.stop()` hang class) = **FAIL**.
