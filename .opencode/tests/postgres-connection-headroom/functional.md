# postgres-connection-headroom — Functional

Durable functional suite for the **embedded-PostgreSQL connection headroom** feature domain: a
second client (the built-in PostgreSQL app, or an external `psql`) can connect to Fredo's own
embedded cluster **while the desktop app is running**, because the SERVER's `max_connections` is
strictly greater than the app pool cap (which stays 8). Seeded at issue **#3028**. Inherits
`.opencode/tests/postgres-lifecycle/`, `postgres-config/`, `postgres-client/`, `postgres-stores/`,
and `headless-ingest/` on the overlapping connection/lifecycle surface.

> **Verification policy: LIVE** — connection admission is a property of the RUNNING embedded
> cluster (a real `psql` / built-in-PG-app client admitted or refused at the shipped server
> limit). The testing exit gate and audit fail-closed unless the Tester's Evidence references a
> live receipt — a `telemetry_spans` query (F-6). A static/unit-only PASS is a FALSE PASS.

> **G-307/G-284 READ LEVER + DISCLOSED SUBSTITUTION.** The sanctioned PG read is the managed
> `psql` via `.opencode/skills/telemetry-query/telemetry-query.ps1` (database `postgres`); port
> from `pg_supervisor_status` / manifest `ports.pg` (never guess a `0` — re-resolve, G-307),
> password from the OS keychain (service `fredo.postgres`, account `loopback:password`) or
> `FREDO_PG_PASSWORD_FILE`. **Because this spec's own subject is the connection budget, the app
> pool can legitimately hold every server slot** — when an external `psql` is refused
> `too many clients`, fall back to the app-pool-backed read (`telemetry_get_stats` /
> `feature_data_read`) for the same-instant number and DISCLOSE the substitution in the verdict
> (`telemetry-query/SKILL.md:51`; precedent `headless-ingest/functional.md:24-30`).

> **G-263 SAFETY (named failure mode): the #2948 ~11 h `pg.stop()` hang.** Every external-runtime
> start (the app dev instance AND the postmaster) MUST be bounded. The live app legs start/stop
> through `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3028` / `-Action Down`
> — never a hand-rolled spawn, never a bare `postgres`/`pg_ctl`. Every managed-`psql` command is
> time-bounded (≤ 60 s). An observed unbounded wait is a FAIL, not a skip.

> **Site map** (the three values this feature reconciles): pool cap `PG_POOL_MAX_CONNECTIONS` at
> `infrastructure/storage/engine.rs:20` (built at `:321`); server limit `("max_connections", "8")`
> in `PG_SERVER_KNOBS` at `applications/pg_supervisor/mod.rs:233-239` (applied to
> `postgresql.conf` at `applications/pg_supervisor/runtime.rs:422`); built-in-app cap
> `MAX_OPEN_CONNECTIONS` at `applications/db_client/connect.rs:66` (per-connection pool
> `.max_connections(1)` at `:260`, guarded at `:564`). The pool cap (8) is UNCHANGED.

## Cases

- [ ] **F-1 (REQ-1 / AC1) — live external `psql` second client while the app runs.**
  Boot the app PG-enabled (dev-env lever); read the port from `pg_supervisor_status` / manifest
  `ports.pg`; connect a managed-`psql` client to database `postgres` and run `SELECT 1`.
  **Expected:** `psql` connects and returns `1` within the connect bound (≤ 10 s); **no** `FATAL:
  sorry, too many clients already`.
  **Edge:** pool at min (1) / mid / full; the pre-fix refusal (negative control); ephemeral port
  re-read (G-307).
  **FAIL** = refusal, hang, or panic.

- [ ] **F-2 (REQ-1 / AC1) — live built-in PG app (db_client) second client.**
  Open the PostgreSQL app surface; add `qa-3028` (host/port from `pg_supervisor_status`, keychain
  password) → Test (success) → Save → Browse / run `SELECT 1`.
  **Expected:** the built-in app connects and queries live (its own pool opens 1 connection).
  **Edge:** read-only default; reconnect after an app restart; the app's own pool at
  `MAX_OPEN_CONNECTIONS`.
  **FAIL** = not saved, refusal, or no live query.

- [ ] **F-3 (REQ-2 / AC2) — the server limit is strictly greater than the pool cap.**
  Read live `SHOW max_connections;` via the managed `psql`; cross-read
  `applications/pg_supervisor/mod.rs:237`.
  **Expected:** live `SHOW max_connections` == the source value `S`, and `S >
  PG_POOL_MAX_CONNECTIONS` (8) — i.e. `S != 8`.
  **Edge:** `S` after a cluster restart; the old equality (`== 8`) is gone.
  **FAIL** = `S == 8`, or a source/live mismatch.

- [ ] **F-4 (REQ-3 / AC3) — FULL-occupancy edge: an extra client still connects.**
  Run `.opencode/tmp/3028/hold.ps1` to hold `PG_POOL_MAX_CONNECTIONS` (8) concurrent bounded
  `psql` sessions (`SELECT pg_sleep(45);`); verify occupancy
  (`SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'` ≥ 9); then open
  one further managed-`psql` `SELECT 1` AND the built-in PG app connection.
  **Expected:** with the pool budget saturated to its cap, BOTH the extra `psql` and the built-in
  app connect (bounded ≤ 10 s, no `too many clients`).
  **Edge:** negative control — pre-fix `S == pool-cap == 8` refuses the 9th admission. **The
  literal app-pool-hold leg needs an Architect-provided test seam** (e.g. env-gated
  `FREDO_PG_POOL_TEST_HOLD=<n>`, inert unset); absent it, this row passes on the server-slot
  manipulation and the literal leg is recorded UNVERIFIED with the named gap.
  **FAIL** = refusal or hang at the 9th admission.

- [ ] **F-5 (REQ-4 / AC4) — the three values consistent + bounded.**
  Read the three sites: `PG_POOL_MAX_CONNECTIONS` (`engine.rs:20`), the server value
  (`pg_supervisor/mod.rs:237`), `MAX_OPEN_CONNECTIONS` (`db_client/connect.rs:66`); cross-check
  the live `SHOW max_connections`.
  **Expected:** pool cap == 8 UNCHANGED; server `> 8`; all three finite/bounded and NOT
  "raise everything"; the built-in-app cap is consistent with the server's spare headroom
  (`MAX_OPEN_CONNECTIONS ≤ S − pool-cap`, or the Architect-declared relationship).
  **Edge:** pool cap raised = FAIL; server `≤` pool = FAIL; any unbounded value = FAIL; comment
  drift at `connect.rs:65` ("mirrors `PG_SERVER_KNOBS`").
  **FAIL** = any of the above.

- [ ] **F-6 (NFR, LIVE receipt) — `telemetry_spans` round start + after.**
  Query `telemetry_spans` for a fresh `e2e-3028-*` session BEFORE the connection work and AGAIN
  after; drive a live OTLP-ingested agent action (never `fredo emit`, G-256); open Mission
  Monitor while the extra client is connected.
  **Expected:** the `telemetry_spans` result is NON-ZERO at both reads with the source disclosed;
  Mission Monitor renders the live session while the extra client is connected.
  **FAIL** = a static-only receipt, or an undisclosed substitution.

## Non-functional

- [ ] **N-1 (bounded/appropriate value):** `S` is a small bounded integer with a declared finite
  ceiling (no unbounded/`0`/"max"); the server memory footprint stays within the tuned desktop
  profile (re-measure if memory knobs change; #2948 RSS baseline).
- [ ] **N-2 (headroom invariant as a unit pin):** a committed unit test asserts
  `server_max_connections() > PG_POOL_MAX_CONNECTIONS` (and `≤` the ceiling), parsing the knob —
  not a doc comment. FAIL if the pin is missing or lives only in prose.
- [ ] **N-3 (loopback-only):** the server binds `127.0.0.1` only (never `0.0.0.0`); the extra
  client connects over loopback; the port never collides with 4317/4318/9223.
- [ ] **N-4 (fail-closed at true capacity):** when all `S` server slots are held, the `(S+1)`th
  client is REFUSED with the structured `FATAL: sorry, too many clients already` — no hang, no
  panic, and the app pool stays functional after the refusal (same occupancy lever).
- [ ] **N-5 (no secret in logs):** the loopback password never appears in the PG log / app logs /
  `telemetry_logs` / `telemetry_spans`; the extra-client connection string is not logged in
  cleartext (sentinel scan).

## Suite-level pass/fail

PASS = F-1..F-6 all green and N-1..N-5 hold, with F-6 carrying a `telemetry_spans` receipt.
Any refusal of a second client while the app runs, any `S == pool-cap`, a raised pool cap, an
unbounded server value, a missing invariant unit pin, a non-loopback bind, a secret in a log, or
a static-only receipt = **FAIL**. UNVERIFIED rows (no reachable lever) are not PASS — the verdict
fails closed (G-033).

## Round 1 results (2026-10-13, `spec/3028 @ 44b26e3`)

Live embedded-PostgreSQL connection-headroom run on the isolated env `spec3028`. Server value is
`max_connections = 12` (strictly > the unchanged pool cap 8); both a managed-`psql` client and the
built-in PG app's `db_connection_test`/`db_connect`/`db_query_execute` path connected and ran
`SELECT 1`; the full-occupancy leg (shared pool holding all 8 slots) still admitted a further client
and the true-capacity leg (12/12 held) refused the next with the structured
`FATAL: sorry, too many clients already`; the existing-cluster overlay was reconciled from a seeded
stale `max_connections = 8` to 12 with **no data reset**. Full receipts in the feature issue's
`## Tests Runs (round 1)` comment.
