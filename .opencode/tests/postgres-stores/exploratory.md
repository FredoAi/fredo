# postgres-stores — Exploratory

Unscripted edge/failure probes for the storage engine seam + shared async PostgreSQL pool domain
(issue #2975 and its following slices). A confirmed finding **promotes** to `functional.md` as a new
`F-` row (keep the origin note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running store layer / app under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); the named failure mode
> is the #2948 ~11 h `pg.stop()` hang. Never an unbounded run. Kill-never-wait on expiry.

> **Induction levers (G-275):** `FREDO_PG_POOL_FORCE_FAIL=1` (forced pool-build failure at a named
> stage) and `FREDO_PG_DATA_DIR` (`features/pg_supervisor/mod.rs:65`, a writable dir under
> `.opencode/tmp/2975/` — use it to probe failure paths). Engine selection is `FREDO_STORAGE_ENGINE`
> (`sqlite`|`postgres`).

## Prompt lines

- [ ] **E-1:** What happens when PG is selected but the pool itself cannot connect (server up, auth
  wrong / database missing) — does the engine seam fall back to SQLite, fail closed with a structured
  error, or hang? Is `fredo.db` untouched either way?
- [ ] **E-2:** Does a long-running store operation hold a pooled connection, and can a burst of
  store reads/writes exhaust `max_connections` (5–10) or queue cleanly without deadlock?
- [ ] **E-3:** Are dynamic `feature_*` identifiers safe against an adversarial/odd feature id — mixed
  case, a leading digit, a name containing a quote, a very long name? Does `validate_namespace`
  reject it before it reaches PG, or does double-quoting save it?
- [ ] **E-4:** Does an `INSERT OR IGNORE` on PG return the same "rows affected" / idempotency signal
  the caller relied on under SQLite, or does a caller misread a 0-row result as an error?
- [ ] **E-5:** Does a BLOB containing bytes that are not valid UTF-8 (or a JSON string with an
  embedded NUL) round-trip byte-identically through `BYTEA` + the JSON bridge?
- [ ] **E-6:** Does the read-only pool handle truly reject a write on PG (not just by convention),
  and does it do so without poisoning the shared pool for the writers?
- [ ] **E-7:** On repeated boot cycles across engines (SQLite → PG → SQLite), is `fredo.db` never
  mutated when PG is active, and does the SQLite build always reopen the same file cleanly?
- [ ] **E-8:** Does a `feature_data_tables` row whose declared physical table is missing/corrupt
  fail closed, or does the projection path silently produce an empty/partial result?
- [ ] **E-9:** What is the tuned peak RSS profile over a sustained session (not just boot) — does
  `max_connections`/memory tuning hold steady, or does RSS drift with pool churn?
- [ ] **E-10:** Is the async fan-out (sync store methods → async) free of a re-render/lock-order
  regression — does the RTDB writer task still coalesce (~30 ms) and never block on the pool?

- [ ] **E-11 (CONFIRMED #2975 round 2 — promoted to functional F-20):** does a declared table with a
  mixed-case column/PK survive PostgreSQL's identifier folding? **No** — the declared-table DDL
  (`registry.rs::create_table_sql`) interpolates identifiers unquoted, so `sessionId` → `sessionid` on
  PG and the quoted write path fails `no existe la columna «sessionId»`. Probe: boot PG-selected with a
  fresh data dir, open Mission Monitor, read `information_schema.columns` for
  `feature_mission_monitor_sessions` (all lowercase) + the backend WARN `declared-table projection
  failed`. Promoted as F-20; regression pin R-17.
