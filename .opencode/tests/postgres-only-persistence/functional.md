# postgres-only-persistence — Functional

> Durable functional suite for the **PostgreSQL-as-the-ONLY-database** feature domain (spec #3005):
> remove SQLite (its driver crate and its synchronous engine), replace the synchronous file-backed
> control plane with a PG-hydrated in-memory settings cache + a JSON `boot-config.json` (postmaster PID
> marker only), move the PG loopback password to the OS keychain, delete the legacy SQLite migration/backout subsystem,
> and sweep agent-facing artifacts off SQLite. One `- [ ]` case per EARS requirement R-1..R-5 (1:1 with
> AC1..AC5) plus the human-directed Mission-Monitor E2E leg.
>
> **Evidence policy: LIVE.** This is a live spec — cold boot + restart + live sessions. The Tester's
> Evidence MUST reference `telemetry_spans` (a live-query result) and/or rendered-webview live receipts
> (DOM snapshots, screenshots, console logs, IPC captures) taken from the built app. A static-only PASS
> is a FALSE PASS.
>
> **Binding names (G-255/G-187):** boot file `<app_data_dir>/boot-config.json` key `postgres_pid`;
> `AppStore::cached_get`/`cached_set`/`hydrate`; PG `settings(key,value)` unchanged; keychain service
> `fredo.postgres` / account `loopback:password`; removed commands `migration_status`/`verify_rollback`/
> `cutover_release_gate`; test seams `FREDO_PG_PASSWORD_FILE` (seed sentinel) + `FREDO_PG_KEYCHAIN_DISABLED`
> (force fallback); retained `FREDO_DATA_DIR`; fallback literal `fredo-loopback-fallback`.
>
> **PG read lever (G-284/G-307):** primary = managed `psql` (database `postgres`) at the
> `pg_supervisor_status` port (`apps/tauri/src-tauri/src/applications/pg_supervisor/state.rs:836`),
> password from the keychain; named fallback = the app-pool-backed `telemetry_get_stats` /
> `feature_data_read`. The ephemeral port may read `0`; if so (or the app pool holds all connections)
> use the named fallback and DISCLOSE the substitution. Never pass a literal out-of-repo toolchain
> path (G-322) — the committed dev-env script probes the managed `psql` internally.
>
> **G-263 SAFETY:** every live leg starts/stops through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3005` / `-Action Down`; never a bare
> `postgres`/`pg_ctl`; the named failure mode is the #2948 ~11 h `pg.stop()` hang. An unbounded wait is
> a FAIL, not a skip.
>
> **Isolated data dir (G-275/G-300):** all cold-boot legs point `FREDO_DATA_DIR` at a fresh dir under
> `.opencode/tmp/3005/` (in-repo write scope) so no real user data is touched and the `.db`-absence scan
> is meaningful.

## Cases

- [ ] **F-1 (R-1/AC1) — fresh-install cold start → PostgreSQL ready; NO `.db` under app-data.**
  Point `FREDO_DATA_DIR` at a fresh `.opencode/tmp/3005/appdata-fresh`; boot. Read
  `storage_engine_status` (`infrastructure/storage/engine.rs:818`); recurse the app-data dir for `*.db`;
  run the residual gate's dependency-tree check (the gate owns the deny token table) + grep
  `Cargo.toml`/`Cargo.lock`; run `cargo check`.
  - EXPECTED: `{ engine:"postgres", ready:true }`; `Get-ChildItem -Recurse -Filter *.db` returns ZERO
    files anywhere under the app-data dir; the SQLite driver crate is absent from the dependency tree AND
    `Cargo.toml`/`Cargo.lock`; `cargo check` emits ZERO warnings.
  - Edge: existing empty data dir; dir containing only `boot-config.json`; pre-seeded keychain; long
    path; a second boot over the same dir creates no `.db`.
  - FAIL: `ready:false`; any `.db` file; the SQLite driver crate present; any `cargo check` warning.

- [ ] **F-2 (R-2/AC2) — formerly-control-plane settings round-trip through the shipped surface AND survive a restart.**
  Through the shipped seam `save_control_setting`/`get_control_setting`
  (`applications/settings/commands.rs:32,41`, consumed by
  `apps/ui/src/shared/window-system/controlSettingAccessor.ts:28,34`), write one value per named family:
  Doom save (`doom_save_v1`), tracing level (`tracing.logging_level`), terminal path (`terminal_work_dir`),
  RTDB retention (`rtdb.retention_days`/`rtdb.max_rows`), app-window presentation
  (`app_window_presentation`). Read each back; fully restart the app; read each back again.
  - EXPECTED: each value equals its written value both before AND after the restart; the cache
    (`AppStore::cached_get`) and the durable read (`AppStore::get`) agree; the persisted row is present
    in the PostgreSQL `settings` table.
  - Edge: write before `hydrate` completes (buffered, flushed by `hydrate`, R-2.2/R-2.3); an unknown key
    returns `None` (consumer default, never `Some("")`); a value changed twice then restart → latest
    value; the tracing subscriber applies the reloaded level without re-initialising (R-2.4).
  - FAIL: a value lost across restart; a duplicate `settings` row; the persisted value absent from PG;
    `Some("")` for an unknown key.

- [ ] **F-3 (R-3/AC3) — password in the OS keychain ONLY; a sentinel never appears in any app-data file, log, or telemetry (negative).**
  With `FREDO_PG_PASSWORD_FILE` seeding the sentinel `qa-3005-sentinel-<guid8>`, boot the app. Then
  scan (a) every file under the app-data dir recursively, (b) the app's log output, and (c)
  `telemetry_spans`/`telemetry_logs` content for the sentinel string. Separately, force the
  keychain-unavailable path with `FREDO_PG_KEYCHAIN_DISABLED` and boot `fredo ingest`.
  - EXPECTED: the sentinel occurs ZERO times in (a)/(b)/(c); the password is read/written only via the
    keychain (`fredo.postgres`/`loopback:password`); with `FREDO_PG_KEYCHAIN_DISABLED` the headless
    `fredo ingest` still boots on `fredo-loopback-fallback` (warned without the value, never persisted).
  - Edge: first run with no keychain entry (generate + store); keychain read error (fall back, no log
    of the value); a stale keychain entry is used (password never re-derived into a file); GUI + headless
    share the SAME credential.
  - FAIL: the sentinel appears in any file/log/span; the secret is logged/exported; headless fails to
    boot when the keychain is unavailable.

- [ ] **F-4 (R-4/AC4) — a pre-existing legacy `fredo.db` is ignored and stays byte-identical.**
  Materialize a fake legacy SQLite file (valid SQLite header + a table) literally named `fredo.db` at
  `.opencode/tmp/3005/appdata-legacy/fredo.db` (in-repo `ephemeral-pipeline-scratch` — allowlisted
  scratch); record its SHA-256 + byte size + mtime; point `FREDO_DATA_DIR` at that dir; boot; read
  `storage_engine_status`; re-hash.
  - EXPECTED: the app starts on PostgreSQL (`engine:"postgres", ready:true`) and does NOT read, carry,
    or migrate the file; SHA-256 + size + mtime are byte-identical after boot; no `-wal`/`-shm` side
    files are created beside it.
  - Edge: an empty legacy file; a read-only legacy file; two consecutive boots; a legacy file present
    with no settings cache yet.
  - FAIL: a hash/size/mtime change; a `.db`-derived carry into PG `settings`; any open-for-write.
  - NOTE: the LIVE leg uses the real filename `fredo.db` under allowlisted scratch (binding refinement
    #4). Naming the legacy store inside this suite to assert its absence is not a gate hit — the gate
    allowlists `.opencode/tests/**` as `test-absence-fixtures`.

- [ ] **F-5 (R-5/AC5) — the residual occurrence gate denies the retired vocabulary and self-tests.**
  Run `.opencode/scripts/check-sqlite-retired.ps1` over the repo; run it again with `-SelfTest`. The
  deny token table lives inside the gate script (class `gate-self-reference`).
  - EXPECTED: the repo scan exits clean (only allowlisted-class hits) and prints the DENY property plus
    hits by class; `-SelfTest` exits 0 after asserting the matcher flags `control.db` (and `fredo.db`)
    and does NOT flag the legitimate keychain service `fredo.dbclient` (word boundary, G-330); the legacy
    engine-selection symbols are absent from the crate; no shipped skill/script/doc/permission references
    SQLite as a LIVE store.
  - Edge: a denied token in a DENY-scope file IS flagged; `historic-narrative` (`references.md` guardrail
    history, `spikes/**`, `docs/README.md`) is NOT flagged; `test-absence-fixtures` (`.opencode/tests/**`,
    `apps/**/tests/**` — suites that NAME the legacy store to assert its absence) is NOT flagged;
    `gate-self-reference` (the checker's own token table + probe) is NOT flagged;
    `ephemeral-pipeline-scratch` (`.opencode/tmp/**`, `.opencode/state/**`) is NOT flagged.
  - FAIL: the gate exits 0 while a denied token sits in a DENY class; `-SelfTest` does not fire; a DENY
    class is silently allowlisted.

- [ ] **F-6 (HUMAN DIRECTIVE, mission-monitor acceptance, E2E LIVE — G-256/G-299) — the RUNNING app boots PG-only, Mission Monitor renders live sessions, and no `.db` file remains.**
  Boot the running app on a fresh `FREDO_DATA_DIR`; confirm `storage_engine_status`. Seed one qualifying
  session with the in-repo OTLP lever
  `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json`
  (POSTs to the app's real OTLP/HTTP receiver `:4318/v1/traces`). Guard: the declared `sessions` row for
  `e2e-copilot2933` has `visibleTurnCount ≥ 1` BEFORE asserting the list. Then open Mission Monitor and
  snapshot the DOM + a `telemetry_spans` query at the same instant; recurse the app-data dir for `.db`.
  - **CURRENT governing mechanism (G-299, traced in-tree):** `MissionMonitorPanel.tsx:19,872` consumes
    `useDeliverySessions()` (`apps/ui/src/applications/mission-monitor/hooks/useSessionHistory.ts:126`),
    which reads `MISSION_MONITOR_SESSIONS_REF` (`:36`) via `useApplicationRead` (`:136`) + table watch
    `useApplicationWatch(..., {scope:{kind:'table'}, initial:true})` (`:138`) and applies
    `sessionRollupQualifies` (`:160`); the backend projection is
    `infrastructure/application_data/session_rollup.rs` (qualification predicate `:45`); the list is
    rendered by `SessionHistoryDrawer.tsx:334` (`.mm-session-row`). NOT the stale hook.
  - EXPECTED: `{ engine:"postgres", ready:true }`; after the seed returns HTTP 200, Mission Monitor
    renders ≥1 `.mm-session-row` and the selected session's canvas renders ≥1 node; the same-instant
    `telemetry_spans` query returns the landed rows for `e2e-copilot2933`; ZERO `.db` files exist under
    the app-data dir.
  - Edge: genuinely empty store (empty state only after the durable read settles); a session still
    streaming (legitimate transient); a full app restart over the same dir re-renders the session.
  - FAIL: a blank Mission Monitor while the declared row qualifies; a `.db` file under app-data; a
    static-only receipt.

## Edge cases (cross-cutting)

- [ ] **E-1 (PG read-lever fallback, G-284/G-307):** when `pg_supervisor_status` port reads `0` or the
  app pool holds all connections, the managed `psql` read is unavailable → use the named app-pool
  fallback `telemetry_get_stats`/`feature_data_read` and DISCLOSE the substitution. Never record a
  read as missing because of the lever.
- [ ] **E-2 (pre-hydration read, R-2.2):** a `cached_get` before `hydrate` returns `None`/default (no
  panic, no async-in-sync deadlock); after `hydrate` the same key serves the persisted value.
- [ ] **E-3 (boot key stays synchronous):** `boot-config.json` `postgres_pid` is read synchronously
  (no await) and is the ONLY key outside PostgreSQL; all other keys resolve from the cache/PG.

## Non-functional

- [ ] **N-1 (build hygiene):** `cargo check --locked` zero warnings AND `cargo clippy --locked -- -D
  warnings` AND `cargo test --locked` green; no `#[allow(...)]`.
- [ ] **N-2 (bounded hydration):** the hydration `SELECT key,value FROM settings` runs once, bounded by
  the pool acquire timeout; a hydration failure leaves the cache at defaults and is logged — never
  blocks boot.
- [ ] **N-3 (no secret exposure):** the password is never logged, exported, or written to app-data; the
  fallback literal is warned about WITHOUT its value (G-272 negative).
- [ ] **N-4 (invariants preserved):** `rtdb.backfill.completed` / `rtdb.backfill.provider.completed.v2`
  markers unchanged; `telemetry_spans` read-only (`begin_read_only`); PG `settings` + the six
  canonical/telemetry tables unchanged (no DDL migration).
- [ ] **N-5 (console clean):** `tauri_read_logs(source="console")` shows no `Error:` / `Uncaught` /
  `Maximum update depth exceeded` across every live leg.

## Suite-level pass/fail

## Run 1 results — 2026-10-08 (spec/3005 @ `1fcdad0d`, env `spec3005` slot 1)

- **F-1 PASS** — `storage_engine_status` `{"engine":"postgres","ready":true,"fallbackReason":null}` (before + after restart); recursive `.db` under app-data = 0; `cargo tree --locked` (default features) has no `rusqlite`/`libsqlite3-sys`/`sqlx-sqlite`; `cargo check --locked` = 0 warnings.
- **F-2 PASS** — six former-control-plane keys written via `save_control_setting`; cached == durable PG read == written; all six survive a full Down/Up restart; unknown key → `null`.
- **F-3 PASS** — `FREDO_PG_PASSWORD_FILE` sentinel `qa-3005-sentinel-a1b2c3d4` absent from app-data (recursive) and telemetry (`telemetry_logs`/`telemetry_spans`/`settings` exact-sentinel 0); `FREDO_PG_KEYCHAIN_DISABLED` headless boot exit 0.
- **F-4 PASS** — legacy `fredo.db` SHA-256 `A4207F36…84808` + size 252 + mtime byte-identical after boot; no `-wal`/`-shm`; headless booted on PG (`start.log` new postmaster).
- **F-5 PASS** — gate `RESULT: CLEAN`, `deny: 0` over 2207 files; `-SelfTest` PASS (control.db/fredo.db flagged, `fredo.dbclient` not).
- **F-6 PASS** — OTLP `--copilot` fixture HTTP 200 (4 spans); declared `sessions` row `e2e-copilot2933` `visibleTurnCount=1`; 1 `.mm-session-row`; same-instant `telemetry_get_stats.spanCount=4`; 0 `.db`; re-renders after restart.
- **E-1 DISCLOSED** — managed `psql` refused (`too many clients`); app-pool fallback (`telemetry_get_stats`/`application_data_read`/durable `get_setting`) used.
- **E-2 PASS** — unknown key → `None`; post-restart persisted values served; hydration buffered-write/flush unit-pinned.
- **E-3 PASS** — `boot-config.json` holds only `postgres_pid` (matches `pg_supervisor_status.pid`); cleared to `{}` on stop.

PASS = F-1..F-6 green with N-1..N-5 holding and E-1..E-3 disclosed. Any `.db` file under app-data, the
sentinel appearing in any file/log/span, a mutated legacy SQLite file, a lost setting across restart,
the SQLite driver crate in the tree, a gate self-test miss, or a blank Mission Monitor while a
qualifying declared row exists = **FAIL**.
