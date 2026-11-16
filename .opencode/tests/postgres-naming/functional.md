# postgres-naming — Functional

Durable functional suite for the **embedded-PostgreSQL cluster identity** feature domain: the
**application database is named `fredo`** (not the generic `postgres`) while the **bootstrap
superuser role stays `postgres`** — **NO role rename** — with a **one-time, catalog-only,
no-data-loss migration** for existing installs whose tables currently live under the `postgres`
database. Seeded at issue **#3036**. Inherits `.opencode/tests/postgres-lifecycle/`,
`postgres-config/`, `postgres-client/`, `postgres-stores/`, `headless-ingest/`, and
`postgres-connection-headroom/` on the overlapping connection/lifecycle surface.

> **Feature tests:** postgres-naming.

> **Verification policy: LIVE** — every AC names an observable property of the RUNNING embedded
> cluster (a live database identity, a live migrated data dir, a live connection, a live
> `max_connections`). The testing exit gate and audit fail-closed unless the Tester's Evidence
> references `telemetry_spans` (F-LIVE). A static/unit-only PASS is a FALSE PASS.

> **Live-receipt note (G-307 / G-284).** `telemetry_spans` is queried at ROUND-START and AGAIN
> after, with the port/store disclosed. The span-producing lever is a real OTLP-ingested app
> action (Terminal agent session or active companion generation) — NEVER `fredo emit` (G-256).
> Sanctioned read: managed `psql` (**db `fredo`, user `postgres`**, port from `pg_supervisor_status`
> / manifest `ports.pg` — re-resolve a `0`, never guess — password from the OS keychain or
> `FREDO_PG_PASSWORD_FILE`). If the app pool holds all server slots and `psql` is refused
> `too many clients`, use the app-pool read (`telemetry_get_stats` / `feature_data_read`) and
> DISCLOSE the substitution.

> **G-263 SAFETY (named failure mode): the #2948 ~11 h `pg.stop()` hang.** Every external-runtime
> start (app dev instance AND postmaster) MUST be bounded. Live app legs start/stop ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down|Restart -Spec 3036` — never a
> hand-rolled spawn, never a bare `postgres`/`pg_ctl`. Every managed-`psql` command is bounded
> (≤ 60 s). An observed unbounded wait is a FAIL, not a skip.

> **Provenance (source sites the rows bind to).** Pool URL builder `runtime.rs:465-467`
> (`connection_url()`); the crate-default username note `runtime.rs:445-448`; the `ALTER USER`
> statement `runtime.rs:273`; the attach URL `state.rs:1296-1298`; `url_with_password`
> `state.rs:846`; the keychain identity `credentials.rs:49-51`; the migration statement
> `ALTER DATABASE postgres RENAME TO fredo` (executed from a connection to a DIFFERENT database,
> `template1`); server knob `mod.rs:237-243` (`max_connections = 12`, Spec #3028).

## Cases

- [ ] **F-1 (REQ-1 / AC1) — fresh boot identity + recorded decision.**
  Boot fresh (`FREDO_PG_DATA_DIR=<scratch>/pgdata-fresh`); read the live identity and the single
  naming constant(s) in source.
  **Expected:** `SELECT current_user, current_database()` ⇒ `postgres` / `fredo`; ONE recorded
  decision (db `fredo`, role `postgres` — the role is NOT renamed); no product path defaults a
  connection to the `postgres` database.
  **Edge:** unquoted lowercase identifier (PG folds case); UI label `Fredo` is not an identifier.
  **FAIL** = any product connection default still targets the `postgres` DATABASE, or the
  bootstrap role is no longer `postgres`.

- [ ] **F-2 (REQ-2 / AC2) — fresh profile connects and serves.**
  On the fresh profile, open Mission Monitor and drive a live session.
  **Expected:** `pg_supervisor_status` `ready`; the app queries; a live session's rows land and
  Mission Monitor renders chat/tools/tokens.
  **FAIL** = a connection error, or a blank Mission Monitor while rows exist.

- [ ] **F-3 (REQ-2 / AC4) — upgraded profile: seed legacy ⇒ migrate, DATA SURVIVES.**
  Seed an EXISTING install whose tables live in the `postgres` database (merge-base pre-change
  build with `FREDO_PG_DATA_DIR=<scratch>/pgdata-legacy`, drive a session; OR the Architect
  database-only test-only seed lever); snapshot per-table counts (`settings`, `telemetry_spans`,
  `telemetry_logs`, `telemetry_metrics`, `chat_rows`, `tool_use_rows`, `agent_session_rows`,
  `feature_data_tables`, `feature_data_tombstones`); stop (bounded); boot the spec build against
  the SAME dir; the one-time migration executes `ALTER DATABASE postgres RENAME TO fredo` from a
  connection to a DIFFERENT database (`template1`); re-snapshot.
  **Expected:** every count IDENTICAL after migration — zero loss, zero orphaned rows;
  **`telemetry_spans` MUST NOT be lost**; the rename is catalog-only (OID-keyed → the `base/<oid>`
  heap files stay in place, no data copy, no orphaning); no manual reconfiguration.
  **Edge:** empty legacy (0 rows); an in-flight/open legacy session; a stray non-Fredo table.
  **FAIL** = any count mismatch, a lost `telemetry_spans`, orphaned data, or a data copy.
  **Needs an Architect-provided database-only seed lever** (see Required test data) — without it
  UNVERIFIED.

- [ ] **F-4 (REQ-2 / AC2) — both profiles connect on their own boot.**
  Boot the fresh profile, then the upgraded profile.
  **Expected:** both are `ready`; both serve a live query as `postgres`/`fredo`.
  **FAIL** = either profile fails to connect.

- [ ] **F-5 (REQ-3 / AC2) — pool URL builder targets the `fredo` database.**
  Inspect the resolved pool URL (`runtime.rs:465-467`) and the live pool.
  **Expected:** `postgresql://postgres:<pw>@127.0.0.1:<port>/fredo` — the user role is `postgres`
  (UNCHANGED), the database is `fredo`.
  **FAIL** = the DATABASE component is `postgres` (that literal is the migration SOURCE only,
  never an application target).

- [ ] **F-6 (REQ-3 / AC2) — attach/headless URL targets the `fredo` database.**
  With a headless daemon owning the cluster, boot the GUI and inspect the attach URL
  (`state.rs:1296-1298`).
  **Expected:** `postgresql://postgres:<pw>@<host>:<port>/fredo`; the GUI attaches (`attached`).
  **FAIL** = the DATABASE component is `postgres`, or a failed attach.

- [ ] **F-7 (REQ-3 / AC3) — `ALTER USER postgres PASSWORD` role UNCHANGED.**
  Inspect the built statement (`runtime.rs:273`); change the password via Settings → PostgreSQL.
  **Expected:** the statement names the role `postgres` (UNCHANGED); the change works in place; the
  OLD password is rejected and the new one authenticates. **NO role rename.**
  **Edge:** a password containing `'`/`\`; the compensating revert (`state.rs:846`).
  **FAIL** = the role name changed (e.g. `fredo`), or a broken password change.

- [ ] **F-8 (REQ-3 / AC3) — keychain identity UNCHANGED (`fredo.postgres`).**
  Read the identity constants (`credentials.rs:49-51`) and the runtime keychain read/write.
  **Expected:** the keychain service/account identity stays `fredo.postgres` / `loopback:password`
  (UNCHANGED — not re-keyed); the credential round-trips; no re-key to `fredo.fredo`.
  **FAIL** = a re-keyed identity, or a credential mismatch.

- [ ] **F-9 (REQ-4 / AC2) — repo grep gate: no residual application-DATABASE `postgres` target.**
  Repo-wide search for `postgres` in connection/role/database context.
  **Expected:** the ONLY hits are the sanctioned allowlist:
  (a) the ROLE name `postgres` (the URL user, `ALTER USER postgres …`, `current_user`);
  (b) the keychain service `fredo.postgres`;
  (c) the migration SOURCE literal `postgres` in `ALTER DATABASE postgres RENAME TO fredo`;
  (d) filesystem/process/binary/wire names — the `postgres` data subdir, `postgres.exe`,
  `Dialect::Postgres`, wire-protocol constants;
  (e) non-product test fixtures.
  The DATABASE name `postgres` MUST appear ONLY as the migration SOURCE, never as an application
  target.
  **FAIL** = any product path that connects to / creates / defaults the application at the
  `postgres` database.

- [ ] **F-10 (REQ-4 / AC2) — tooling defaults use `fredo`.**
  Inspect `telemetry-query.ps1` (`:71-72`) and `SKILL.md` (`:14,29,61,73`).
  **Expected:** the `-PgDatabase` default reads `fredo`; the `-PgUser` default reads `postgres`
  (UNCHANGED role); the SKILL text matches.
  **FAIL** = a `postgres` DATABASE default, or a changed user default.

- [ ] **F-11 (REQ-4 / AC2) — docs match.**
  Inspect `SETUP.md:216`, `telemetry-reference.md:279`, `playbooks/references.md:21`.
  **Expected:** each names the application database `fredo` and the role `postgres`;
  `CLI_GUIDE.md:168` stays a PATH (filesystem exception).
  **FAIL** = a doc naming the old application database without being on the allowlist.

- [ ] **F-12 (REQ-5 / AC5) — an upgraded install connects unchanged + idempotent.**
  Re-boot the migrated legacy dir with NO manual reconfiguration; re-boot once more.
  **Expected:** `ready`; `SELECT current_user, current_database()` ⇒ `postgres`/`fredo`; the second
  boot performs NO second `ALTER DATABASE … RENAME` (skipped/guarded because the database is
  already `fredo`) and counts are unchanged (idempotent); zero user action.
  **Edge:** interrupted upgrade; stale legacy credential; a copied legacy dir.
  **FAIL** = a required reconfiguration, a second migration, or a re-boot failure.

## Non-functional

- [ ] **N-1 (loopback-only):** the cluster LISTENs `127.0.0.1` only (never `0.0.0.0`);
  `pg_hba.conf` host entries are `127.0.0.1/32` and/or `::1`; migration adds no non-loopback rule.
- [ ] **N-2 (no plaintext secret):** a `qa3036-sentinel-<uuid>` password appears in NO app-data
  config / `settings` / `telemetry_logs` / `telemetry_spans` / `telemetry_metrics` /
  `postgres.log` (OS keychain excepted); `ALTER USER postgres … PASSWORD` is redacted in logs.
- [ ] **N-3 (migration atomic + idempotent):** a re-run is a byte-identical no-op (the
  `ALTER DATABASE … RENAME` is skipped/guarded when the database is already `fredo`); an
  interrupted run leaves EITHER the legacy database name `postgres` with ALL rows intact OR the
  fully-renamed database `fredo` with ALL rows intact — never a half-renamed cluster (the rename is
  a single catalog operation, OID-keyed, the `base/<oid>` files never touched), never data loss.
  **Needs the Architect interruption lever — else UNVERIFIED, fails closed (G-033).**
- [ ] **N-4 (deterministic bootstrap):** fresh-boot 3× into distinct dirs ⇒ identical database name
  `fredo`, identical role `postgres`, identical schema, identical `max_connections`.
- [ ] **N-5 (#3028 headroom preserved):** `SHOW max_connections` == 12 (`PG_SERVER_MAX_CONNECTIONS`)
  and `> PG_POOL_MAX_CONNECTIONS` (8); a second client connects concurrently; the
  `server_knobs_max_connections_…` unit pin is present; migration MUST NOT regress it to 8.

## F-LIVE (live receipt)

- [ ] **F-LIVE:** `telemetry_spans` count at ROUND-START and after (non-zero, port/store
  disclosed); a real OTLP-ingested session renders in Mission Monitor while the second client is
  connected. Disclose any app-pool substitution; `fredo emit` is never the lever (G-256).

## Suite-level pass/fail

PASS = F-1..F-12 + N-1..N-5 + F-LIVE all green, with F-LIVE carrying a `telemetry_spans` receipt.
Any lost `telemetry_spans` row, a count mismatch on upgrade, a required manual reconfiguration, a
half-renamed cluster, a product path still targeting the `postgres` DATABASE, a renamed role, a
non-loopback bind, a plaintext secret, a regressed `max_connections`, or a static-only receipt =
**FAIL**. UNVERIFIED rows (no reachable lever) are not PASS — the verdict fails closed (G-033).

## Required test data

- Scratch root: `.opencode/tmp/3036/` — `pgdata-fresh/`, `pgdata-legacy/`, `lock/`, `install/`,
  `e2e/` (in-repo only; no out-of-repo asset/model/media).
- Induction seams: `FREDO_PG_DATA_DIR` (`mod.rs:95`), `FREDO_PG_INSTALL_DIR` (`:102`),
  `FREDO_PG_LOCK_DIR` (`:63`); headless `FREDO_INGEST_DESCRIPTOR` (`:70`),
  `FREDO_INGEST_SHUTDOWN_FILE`, `FREDO_INGEST_RUN_MS`; fault `FREDO_PG_POOL_FORCE_FAIL` (`:115`),
  `FREDO_PG_FORCE_START_FAIL` (`:133`). **Architect lever needed for the seed:** a database-only
  test-only seed lever (env-gated, inert unset) OR the merge-base pre-change build.
- Live app lever: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down|Restart
  -Spec 3036`; read `pg_supervisor_status` / manifest `ports.pg` (re-resolve a `0`, G-307).
- Read lever: managed `psql` via `run-exitcode.ps1 -Command` (db `fredo`, user `postgres`, ≤ 60 s),
  and the `telemetry-query` skill (`telemetry-query.ps1`, db `fredo`, user `postgres`).
- Live producer (G-256): a real OTLP-ingested Terminal agent session or companion generation.
- Environment note (G-280): an orphan `postgres.exe` / stale socket after `dev-env -Action Down` is
  a known artifact, never a spec FAIL.
