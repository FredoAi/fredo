# postgres-naming — Regression

> "Must not change" baseline for the embedded-PostgreSQL cluster identity domain. Seeded at issue
> **#3036**. These invariants MUST hold after the database rename (`postgres` → `fredo`) + the
> one-time catalog-only migration — any FAIL is a regression. The bootstrap superuser ROLE stays
> `postgres` (NO role rename); only the application DATABASE is renamed.
> Run on every testing phase that touches the Postgres bootstrap, connection/credential paths, the
> RTDB row pipeline, or the Mission Monitor rendering path.
>
> **Verification policy: live** — the app-boot + data-survival invariants are only observable on a
> running app; the Tester's Evidence MUST reference `telemetry_spans` (functional F-LIVE).

> **G-263 SAFETY:** every live leg is bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3036`. Never an unbounded
> run; never a bare `postgres`/`pg_ctl`. Named failure mode: the #2948 ~11 h `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (zero data loss):** an upgraded install keeps EVERY row — no table dropped, no rows
  orphaned; `telemetry_spans` (and every `telemetry_*` / `*_rows` / `feature_data_*` / `settings`
  table) has the same or greater count after the migration. This is functional F-3 mirrored as a
  standing invariant. The catalog-only `ALTER DATABASE postgres RENAME TO fredo` copies no data and
  leaves the `base/<oid>` heap files in place.
  **Edge / FAIL:** any count decrease, a dropped table, or a lost `telemetry_spans` row.

- [ ] **R-2 (fresh + upgraded both connect):** both profiles boot to `ready` and serve queries as
  `postgres`/`fredo` on their own data dir.
  **Edge / FAIL:** either profile fails to connect, or requires manual reconfiguration.

- [ ] **R-3 (#3028 headroom preserved):** `max_connections` stays 12 (strictly > the unchanged pool
  cap 8); a second client still connects while the app runs; the pool cap `PG_POOL_MAX_CONNECTIONS`
  stays 8; the migration MUST NOT regress the overlay to the `initdb` default.
  **Edge / FAIL:** `max_connections == 8`, a collision with 4317/4318/9223, or a raised pool cap.

- [ ] **R-4 (loopback-only):** the cluster still binds `127.0.0.1` only; `pg_hba.conf` host entries
  stay loopback; OTLP 4317/4318 and the MCP bridge 9223 still bind.
  **Edge / FAIL:** a non-loopback bind introduced by the migration.

- [ ] **R-5 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types are unchanged; emission remains ONLY via
  `EventBus.emit_row_delivery_batch` — no `app_handle.emit()` for row deliveries.
  **Edge / FAIL:** any row-pipeline hunk, a new event type/payload field, or a direct emit.

- [ ] **R-6 (Mission Monitor renders from the store — live):** after the database rename + migration
  the app still boots and Mission Monitor still renders live sessions / chat / tools / tokens;
  cross-check `telemetry_spans` at the same instant (F-LIVE mirrored).
  **Edge / FAIL:** a blank/empty Mission Monitor while stored/live rows exist.

- [ ] **R-7 (bounded lifecycle intact):** the #2974 supervisor layers (bounded start/stop, PID
  marker sweep, guaranteed teardown, hard-kill fallback) remain; the migration adds no unbounded
  wait.
  **Edge / FAIL:** an await without a finite bound, or a surviving started `postgres.exe` after quit.

- [ ] **R-8 (build gates):** `cargo check --locked` 0 warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green; if the UI is touched,
  `pnpm --filter @fredo/ui build` exits 0 with zero TS errors.
  **Edge / FAIL:** `cargo check` green but clippy red, or any warning.

- [ ] **R-9 (no cross-feature imports / architecture boundaries):** no cross-feature import; the
  database rename/migration lives in the owning `applications/pg_supervisor/*` module;
  `tauri::async_runtime::spawn` is used, never `tokio::spawn`.
  **Edge / FAIL:** a `tokio::spawn` or a feature→feature import.

- [ ] **R-10 (AppStore KV contract unchanged):** the `settings(key,value)` KV shape is unchanged;
  the PID marker and credential keys are keys in the same KV, not a schema change. The keychain
  identity stays `fredo.postgres` (UNCHANGED).
  **Edge / FAIL:** a `settings` table migration or schema change beyond the database rename.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-11:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the lifecycle
  supervisor surface (boundedness, teardown, orphan sweep) this rename must not disturb.
- [ ] **R-12:** inherit and run `.opencode/tests/postgres-config/regression.md` — the Settings →
  PostgreSQL surface (password change, port pin, reset) whose `ALTER USER postgres` path is
  UNCHANGED (role stays `postgres`).
- [ ] **R-13:** inherit and run `.opencode/tests/postgres-client/regression.md` — the built-in
  PostgreSQL client's live-connection surface (its default db `fredo` / user `postgres` assumptions).
- [ ] **R-14:** inherit and run `.opencode/tests/postgres-stores/regression.md` — the shared pool /
  store-migration surface and its preservation contract.
- [ ] **R-15:** inherit and run `.opencode/tests/headless-ingest/regression.md` — the headless
  daemon / attach surface (the descriptor + attach URL target the renamed db `fredo`; role
  unchanged).
- [ ] **R-16:** inherit and run `.opencode/tests/postgres-connection-headroom/regression.md` — the
  `max_connections` headroom invariant the migration must not regress.

## Notes

- This suite is reusable across every later slice that touches the cluster identity or the
  connection/credential paths. The identity decision (application database `fredo`, bootstrap role
  `postgres` — NO role rename) is the durable contract; the display name `Fredo` stays a UI label
  only.
