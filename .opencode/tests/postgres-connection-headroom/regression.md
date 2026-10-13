# postgres-connection-headroom — Regression

> "Must not change" baseline for the embedded-PostgreSQL connection-headroom domain. Seeded at
> issue **#3028**. These invariants MUST hold after the change — any FAIL is a regression. Run on
> every testing phase that touches cluster sizing, the pool cap, the built-in PG client, or the
> RTDB row pipeline.
>
> **Verification policy: LIVE** — the app-boot, live-client, and row-pipeline invariants are only
> observable on a running app; the Tester's Evidence MUST reference `telemetry_spans` (via
> functional F-6). A static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3028` / `-Action Down`. Never
> an unbounded run; never a bare `postgres`/`pg_ctl`.

## Must NOT change (regression invariants)

- [ ] **R-1 (pool cap unchanged):** `PG_POOL_MAX_CONNECTIONS == 8`
  (`infrastructure/storage/engine.rs:20`) and the pool is still built with exactly that cap
  (`:321`). The fix raises the SERVER limit, never the app pool cap.
  **Edge / FAIL:** a raised/removed pool cap, or a per-store/second pool.

- [ ] **R-2 (single shared pool):** still exactly ONE `sqlx::PgPool`, built once on the background
  task after `await_ready` and installed once into the shared `EngineHandle`; the built-in client
  keeps its own per-connection pool (`.max_connections(1)`, `db_client/connect.rs:260`) — no new
  per-query connection churn.
  **Edge / FAIL:** a second app pool, or a per-store `Connection::open`.

- [ ] **R-3 (server limit is the ONLY raised value):** no "raise everything" — the built-in-app cap
  (`MAX_OPEN_CONNECTIONS`, `db_client/connect.rs:66`) and the pool cap stay bounded and consistent
  with the server's spare headroom; no unbounded/`0`/"max" value appears.
  **Edge / FAIL:** an unbounded server value, or the built-in-app cap exceeding the headroom with
  no declared relationship.

- [ ] **R-4 (loopback-only + no port collision):** the PG server binds `127.0.0.1` only; OTLP gRPC
  4317 / HTTP 4318 and the MCP bridge 9223 still bind; the PG port (ephemeral or pinned) never
  collides with them (`postgres-config` R-3 mirrored).
  **Edge / FAIL:** a `0.0.0.0` bind, or an OTLP/MCP bind failure after the change.

- [ ] **R-5 (lifecycle + teardown untouched):** the bounded start/stop, the watchdog hard-kill
  fallback, the exit hook, and the orphan sweep keep their behaviour; no new unbounded await
  (`postgres-lifecycle` R-family).
  **Edge / FAIL:** a new unbounded await, or a broken exit-hook teardown.

- [ ] **R-6 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and row wire types are unchanged; emission remains ONLY via
  `EventBus.emit_row_delivery_batch` — no `app_handle.emit()` for row deliveries.
  **Edge / FAIL:** any row-pipeline hunk, a new event type/payload field, or a direct emit.

- [ ] **R-7 (Mission Monitor renders from the store — live):** after the change the app still boots
  and Mission Monitor still lists live sessions and renders chat / tools / tokens from the RTDB
  rows; cross-check `telemetry_spans` at the same instant (functional F-6 mirrored).
  **Edge / FAIL:** a blank/empty Mission Monitor while stored/live rows exist.

- [ ] **R-8 (no cross-feature imports / spawn discipline):** no cross-feature import; sizing state
  stays in the owning modules; `tauri::async_runtime::spawn` is used, never `tokio::spawn`.
  **Edge / FAIL:** a `tokio::spawn` or a feature→feature import.

- [ ] **R-9 (build gates):** `cargo check --locked` zero warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green; if UI is touched,
  `pnpm --filter @fredo/ui build` exits 0 with zero TS errors (functional N-1).
  **Edge / FAIL:** `cargo check` green but clippy/UI-build red.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-10:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the bounded
  lifecycle / teardown surface the cluster start reuses.
- [ ] **R-11:** inherit and run `.opencode/tests/postgres-config/regression.md` — the managed-PG
  config + loopback/port surface the server knob is applied on.
- [ ] **R-12:** inherit and run `.opencode/tests/postgres-client/regression.md` — the built-in
  PostgreSQL client surface that supplies the second (headroom) client.
- [ ] **R-13:** inherit and run `.opencode/tests/postgres-stores/regression.md` — the shared-pool /
  store surface whose connection count is bounded by the cap.
- [ ] **R-14:** inherit and run `.opencode/tests/headless-ingest/regression.md` — the
  cluster-ownership / two-client (daemon + GUI) surface with the same "too many clients" read
  caveat.
