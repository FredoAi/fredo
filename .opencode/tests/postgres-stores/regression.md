# postgres-stores — Regression

> "Must not change" baseline for the storage engine seam + shared async PostgreSQL pool domain
> (slice 2 of 6). Seeded at issue **#2975**. These invariants MUST hold after the slice — any FAIL
> is a regression. Run on every testing phase that touches the store layer, app startup, the RTDB
> row pipeline, or the Mission Monitor rendering path.
>
> **Verification policy: live** — the app-boot + row-pipeline invariants are only observable on a
> running app; the Tester's Evidence MUST reference `telemetry_spans` (via functional F-16) for a
> live verdict. A static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `.opencode/scripts/dev-env.ps1 -Action Up -Spec 2975` / `-Action Down`; never an unbounded run;
> never a bare `postgres`/`pg_ctl`. The named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types (`RowDelivery` / `RowDeliveryBatch`) are unchanged;
  emission remains ONLY via `EventBus.emit_row_delivery_batch` — no `app_handle.emit()` row delivery;
  the async fan-out changes signatures only, never merge behaviour.
  **Edge / FAIL:** a row-pipeline semantic hunk, a new event type/payload field, or a direct emit.

- [ ] **R-2 (Mission Monitor renders from the store — live):** after the change the app still boots,
  and Mission Monitor still lists live sessions and renders chat / tools / tokens from the RTDB rows;
  cross-check `telemetry_spans` at the same instant. Functional F-16 mirrored as a standing invariant.
  **Edge / FAIL:** a blank/empty Mission Monitor while stored/live rows exist.

- [ ] **R-3 (SQLite path byte-identical when selected):** with SQLite selected, the default-boot
  behaviour and the existing store unit tests are byte-identical to pre-slice; `fredo.db` is opened
  exactly as before; no `fredo.db` schema change.
  **Edge / FAIL:** any user-visible change, a `fredo.db` schema change, or a red existing test.

- [ ] **R-4 (`telemetry_spans` stays strictly READ-ONLY):** the RTDB canonical backfill and the
  declared-table backfill never write `telemetry_spans`; the read-only contract is preserved on the
  pool (`START TRANSACTION READ ONLY` / read-only role).
  **Edge / FAIL:** a write reaching `telemetry_spans`, or a read path that requires write perms.

- [ ] **R-5 (NFR-6 single extraction path):** `infrastructure/rtdb/attrs.rs` remains the ONE shared
  extract-rule implementation for the live classifier AND the canonical backfill — no fork, no
  duplicate extraction path; the store swap does not touch extraction.
  **Edge / FAIL:** a duplicated extraction path in backfill code.

- [ ] **R-6 (store domain types + KV/one-shot marker semantics unchanged):** the domain types
  (`ChatRow`, `ToolUseRow`, `AgentSessionRow`, `TelemetrySpan`, `TableMeta`, `Tombstone`, `ColumnDef`)
  and the `AppStore` KV shape are unchanged; the one-shot markers (`rtdb.backfill.completed`,
  `rtdb.backfill.provider.completed.v2`, per-table `feature_data_tables.backfill_done`) keep their
  carried-verbatim semantics; durable seq (`COALESCE(MAX(seq),0)`) never resets across restart.
  **Edge / FAIL:** a carried marker re-derived, or a domain-type field change.

- [ ] **R-7 (architecture boundaries):** no cross-feature import; `tauri::async_runtime::spawn` is
  used, never `tokio::spawn`; `comm/` stays minimal (wire types + EventBus); row-pipeline code stays
  in `infrastructure/rtdb/`.
  **Edge / FAIL:** a `tokio::spawn` or a feature→feature import.

- [ ] **R-8 (build gates):** `cargo check --locked` zero warnings AND `cargo clippy --locked -- -D
  warnings` AND `cargo test --locked` green. If UI is touched, `pnpm --filter @fredo/ui build` exits 0.
  **Edge / FAIL:** `cargo check` green but clippy red (check alone does NOT clear the clippy gate).

- [ ] **R-9 (no unbounded run introduced):** no new code path introduces an unbounded/blocking wait;
  the slice-1 bounded stop + watchdog + fallback + sweep layers still hold behind the new pool.
  **Edge / FAIL:** any await without a finite bound.

- [ ] **R-13 (PG integration suite stays OFFLINE by default):** the cross-engine binary
  `apps/tauri/src-tauri/tests/storage_engine_pg.rs` is gated behind `FREDO_TEST_PG=1`; a plain
  `cargo test --locked` / `cargo nextest run` executes it as an immediate no-op — no embedded server,
  no network, no `.opencode/tmp` writes. The real suite runs ONLY via
  `FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg`, against ONE embedded server with
  per-scenario `CREATE SCHEMA` + `search_path` isolation.
  **Edge / FAIL:** the gated tests start a server (or create a data dir) without `FREDO_TEST_PG=1`,
  or default `cargo test` regresses to requiring PostgreSQL.

- [ ] **R-14 (cross-engine test harness is itself bounded — G-263 induction):** every external-runtime
  leg of the PG suite uses the slice-1 bounded `PgRuntime` (`Settings::timeout` + `run_bounded` +
  stop watchdog + `taskkill` fallback) and `FREDO_PG_DATA_DIR` under `.opencode/tmp/2975/`; teardown is
  guaranteed on the normal / error / panic paths (RAII `Drop`), the stop is finite, and a post-stop
  port re-probe proves no orphan postmaster. Tests assert the SQLite↔PG fixture is byte-equal (row
  count + content checksum) across `settings` / `feature_*` / `feature_data_*`.
  **Edge / FAIL:** an unbounded start/stop, a PG suite leg without a finite bound, an orphan
  postmaster after teardown, or a count/checksum divergence.

- [ ] **R-15 (PG-selected boot serves feature-data — FAIL #2975 round 1):** after the engine swap,
  EVERY global schema the SQLite boot creates (`feature_data_tables`, `feature_data_tombstones`,
  declared `feature_*`) MUST exist on the PostgreSQL pool, so a feature-data read/write/declare on PG
  succeeds and Mission Monitor renders. A schema ensured only in the synchronous setup closure (while
  the handle is still SQLite) and never re-ensured on the installed pool is the round-1 defect.
  **Edge / FAIL:** `public` holds only `settings`; "no existe la relación «feature_data_tables»"; an
  empty Mission Monitor on a PG-selected boot.
  **Round 2:** the schema-set half is FIXED (PG `public` = `settings` + `feature_data_tables` +
  `feature_data_tombstones` + `feature_terminal_sessions` + the declared `feature_mission_monitor_sessions`;
  the `no existe la relación` error is gone). The MM half STILL FAILS via a second, deeper defect —
  see R-17 (unquoted declared-table DDL → lowercase PG columns).

- [ ] **R-17 (declared-table DDL must quote identifiers on PostgreSQL — FAIL #2975 round 2):**
  `feature_data/registry.rs::create_table_sql` MUST `quote_ident` every declared column, the physical
  table name, and the PK list (as `FeatureStore::ensure_table_on_pg` does). SQLite folds case
  insensitively, so raw identifiers work there; PostgreSQL folds unquoted camelCase to lowercase, so a
  declared `sessionId`/`latestAt` column becomes `sessionid`/`latestat` and the quoted write path
  (`FeatureStore::upsert`) fails `no existe la columna «sessionId»`.
  **Edge / FAIL:** a PG declared table whose `information_schema.columns` do not match the declared
  names; any projection write error on a mixed-case declared column; an empty Mission Monitor on PG.

- [ ] **R-16 (gated cross-engine suite green + hex-case normalized — FAIL #2975 round 1):** the
  `FREDO_TEST_PG=1` cross-engine content checksum MUST normalize representation (hex case) so a
  BLOB-bearing table compares equal across engines. **Edge / FAIL:** a red suite from a case-only
  rendering difference (SQLite `hex()` uppercase vs PG `encode(…,'hex')` lowercase).
  **Round 2:** the hex-case fix WORKED — Phase 1 (row-count + SHA-256 content checksum + all AC4 edges)
  passes. The suite is STILL red, now at `tests/storage_engine_pg.rs:278` (`quoted_identifier_scenario`):
  `to_regclass('"feature_CaseTest_widgets"')::text` yields `"feature_CaseTest_widgets"` (PG quotes the
  mixed-case identifier in regclass text) but the assertion expects the unquoted form — a test
  expectation defect. Phase 3 (`schema_init_scenario`) never ran.

- [ ] **R-18 (teardown leaves no orphan postmaster — G-263):** after every live leg's
  `dev-env.ps1 -Action Down`, no `postgres.exe` may survive. **Round 2 observation:** the FINAL tuned
  leg (no subsequent boot to reclaim it) left 9 `postgres.exe` (postmaster pid 13800, port 49911) alive
  40 s+ after Down (no `fredo.exe` present) — `Down` hard-kills the app (`taskkill /F /T /IM fredo.exe`)
  and the managed postmaster survived; earlier legs were reclaimed by the next boot's sweep.
  **Edge / FAIL:** any `postgres.exe` alive after teardown with no owning app.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-10:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` (R-1..R-12) — the
  supervisor this slice builds on; the pool is built on the background task after the supervisor's
  `await_ready` resolves and must not disturb the lifecycle.
- [ ] **R-11:** inherit and run `.opencode/tests/mission-monitor/regression.md` — the row-pipeline /
  Mission Monitor surface this store swap must not disturb.
- [ ] **R-12:** inherit and run `.opencode/tests/event-persistence/` and `.opencode/tests/realtime-data/`
  regression legs (when present) — the RTDB row-pipeline / feature-data surface.

## Notes

- This suite is reusable across the remaining Postgres store slices. Slice 2 migrates only the
  `AppStore` / `FeatureStore` / `FeatureDataStore` + read-only paths onto the shared pool;
  `SpanStore` / `RtdbStore` and the write-behind/LRU path are slice 3 and must remain untouched here.
