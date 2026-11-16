# postgres-client — Regression

> "Must not change" baseline for the built-in PostgreSQL client feature domain. Seeded at
> issue **#2950**. Run on every testing phase that touches the Postgres client surface, the
> embedded PG supervisor, app startup, the RTDB row pipeline, or the Mission Monitor
> rendering path.
>
> **Verification policy: live** — the app-boot + row-pipeline invariants are only observable
> on a running app; the Tester's Evidence MUST reference `telemetry_spans` (functional F-11)
> for a live verdict. A static-only PASS is a FALSE PASS.

> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2950` / `-Action Down`.
> Never an unbounded run; never a bare `postgres`/`pg_ctl`/`psql`.

## Must NOT change (regression invariants)

- [ ] **R-1 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier /
  merge / flush / query semantics and the row wire types are unchanged; emission remains ONLY
  via `EventBus.emit_row_delivery_batch`.
  **Edge / FAIL:** any row-pipeline hunk, a new event type/payload field, or a direct emit.

- [ ] **R-2 (Mission Monitor renders from the store — live):** after the change the app still
  boots and Mission Monitor still lists live sessions and renders chat / tools / tokens from
  the RTDB rows; cross-check `telemetry_spans` at the same instant. Mirrors functional F-11.
  **Edge / FAIL:** a blank/empty Mission Monitor while stored/live rows exist.

- [ ] **R-3 (embedded PG supervisor untouched):** the `pg_supervisor` bounded start/stop,
  orphan sweep, teardown, and ephemeral-port behaviour are unchanged; the client connects to
  the embedded server without disturbing its lifecycle. Run
  `.opencode/tests/postgres-lifecycle/regression.md`.
  **Edge / FAIL:** a changed start/stop bound, an orphan, or a stale marker.

- [ ] **R-4 (OTLP + MCP binds unchanged):** OTLP gRPC 4317 / HTTP 4318 and the MCP bridge 9223
  still bind on 127.0.0.1; the client introduces no colliding fixed port.
  **Edge / FAIL:** a fixed client port colliding with 4317/4318/9223.

- [ ] **R-5 (no cross-feature imports / architecture boundaries):** no cross-feature import
  introduced; `tauri::async_runtime::spawn` is used, never `tokio::spawn`; DB access goes
  through the shared PG pool, not a new ad-hoc connection manager.
  **Edge / FAIL:** a `tokio::spawn` or a feature→feature import.

- [ ] **R-6 (credential path unchanged for the embedded server):** the
  `postgres.password` AppStore key / supervisor connection path is unchanged; the client's
  saved connections are a separate store and do not alter the embedded server's credentials.
  **Edge / FAIL:** the embedded server's password/URI path mutated by the client feature.

- [ ] **R-7 (build gates):** `cargo check --locked` zero warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green; if UI is touched,
  `pnpm --filter @fredo/ui build` exits 0 with zero TS errors.
  **Edge / FAIL:** `cargo check` green but clippy red, or any warning.

- [ ] **R-8 (no unbounded run introduced):** no new code path introduces an unbounded/blocking
  wait; connection attempts, queries, and exports are all bounded.
  **Edge / FAIL:** any await without a finite bound.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-9:** inherit and run `.opencode/tests/mission-monitor/regression.md` — the
  row-pipeline / Mission Monitor surface the client must not disturb.
- [ ] **R-10:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the
  embedded PG supervisor surface.
- [ ] **R-11:** inherit and run `.opencode/tests/postgres-stores/regression.md` — the PG store
  surface the client shares.
- [ ] **R-12:** inherit and run `.opencode/tests/settings/regression.md` — the settings
  surface the client's auto-discovered settings register into.

## Server-side read-only hardening baseline (#3080)

The server-side layer is **additive** on top of the client-side gate: layer 1
(`readOnlyBlocked`, `query.rs:103-115`) is unchanged, and the change only moves four leading
keywords between existing `StatementClass` variants. Links point at the cases that already cover
each invariant.

- [ ] **R-13 (client-side gate unchanged):** a read-only connection still refuses every
  non-`read` statement with `readOnlyBlocked` **before** any server contact; `DEFAULT_ACCESS_MODE`
  stays `ReadOnly`. Overlaps `postgres-client F-9/F-19`, `db-client-builtin R-2`,
  `sql-studio R-III`.
  **FAIL** = the gate is bypassed or the default changed.
- [ ] **R-14 (wire contract unchanged):** `StatementClass` keeps its five variants + `camelCase`
  serde names; the TS mirror (`apps/ui/.../lib/types.ts:164`) is untouched; no persisted document
  shape changes. Overlaps `sql-studio R-II`.
  **FAIL** = a renamed/added variant, a serde-name change, or a TS-mirror edit.
- [ ] **R-15 (pool semantics unchanged):** `min_connections(0)` / `max_connections(1)` /
  `acquire_timeout(CONNECT_BOUND)` and the per-connection `access_mode` persistence rules are
  unchanged; the transient `db_connection_test` probe gets no hook and still runs only
  `SELECT version()`.
  **FAIL** = a changed pool bound or a hooked transient probe.
- [ ] **R-16 (destructive confirmation unchanged):** `ALTER` stays `Destructive` and `INSERT`
  stays `Write`; the read-write confirmation gate still fires for `Destructive | Unknown` and
  still executes nothing unconfirmed. Overlaps `postgres-client F-5/F-22`.
  **FAIL** = a changed class or an unconfirmed execution.
- [ ] **R-17 (cost + secrecy):** the hook runs once per physical connection (no per-query
  round-trip); no password appears in any error message, log, or telemetry (the hook failure
  flows through `sanitize`). Overlaps `postgres-client F-10`.
  **FAIL** = a per-query `SET`, or a secret in a surface.
- [ ] **R-18 (build gates):** re-run `R-7` (`cargo check` zero warnings, `cargo nextest run`
  green). **FAIL** = any warning or failing test.

## Notes

- The client is additive: it reads/writes user databases through the shared PG pool and must
  not alter the embedded server's lifecycle, credentials, or the RTDB row pipeline.
