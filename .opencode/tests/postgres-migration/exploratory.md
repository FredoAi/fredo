# postgres-migration — Exploratory

Unscripted edge/failure probes for the one-shot `fredo.db` → PostgreSQL data migration domain
(issue #2977 and its following slices). A confirmed finding **promotes** to `functional.md` as a new
`F-` row (keep the origin note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running migration / app under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); the named failure mode
> is the #2948 ~11 h `pg.stop()` hang. Never an unbounded run. Kill-never-wait on expiry.

> **Induction levers (G-275):** `FREDO_MIGRATION_FAULT` ∈ {`parity_mismatch`, `export_error`,
> `snapshot_fail`} (architect to confirm the name); an app-data-dir override (`FREDO_DATA_DIR` or a
> standalone migration entry point) pointing at a fixture dir under `.opencode/tmp/2977/`;
> `FREDO_STORAGE_ENGINE` (`sqlite|postgres`), `FREDO_PG_DATA_DIR`, `FREDO_PG_POOL_FORCE_FAIL=1`.

## Prompt lines

- [ ] **E-1:** What happens if the process is killed mid-export (between chunks)? Does the next
  startup detect the partial state and re-run the idempotent export cleanly, or does it leave
  duplicate/partial rows in PostgreSQL? Is `fredo.db` untouched either way?
- [ ] **E-2:** Does a table with ZERO rows, or a table added to `fredo.db` between two runs, parity
  correctly? Does the gate treat an empty source table and a missing target table as equal?
- [ ] **E-3:** Is the checksum encoding stable for adversarial content — NULLs, non-UTF-8 BLOBs,
  embedded NULs, mixed-case hex, values differing only by trailing whitespace? Does the encoding
  normalize representation (hex case, NULL ordering) without masking a real content difference?
- [ ] **E-4:** What happens if a writer is NOT quiesced during the parity window (a mid-parity
  write)? Is the write refused/blocked, or does it slip in and produce a false mismatch? Is the
  snapshot then invalid?
- [ ] **E-5:** Does the migration handle a `settings` key whose value is the empty string, a lone
  NUL, or a very long string — carried byte-for-byte, or normalized/dropped?
- [ ] **E-6:** On a `feature_data_tables` row whose declared physical `feature_*` table is missing
  or corrupt, does the export fail closed or silently produce an empty/partial copy?
- [ ] **E-7:** What is the peak RSS/working-set profile of a full-size copy — does memory stay
  bounded across chunks, or does the export materialize a whole table? How does it scale with the
  largest table?
- [ ] **E-8:** Repeated boot cycles across engines (SQLite → PG → SQLite → PG): is `fredo.db` never
  mutated while PG is active, and does the SQLite build always reopen the same file cleanly?
- [ ] **E-9:** Does the parity gate compare `telemetry_spans` too, and does it ever attempt a write
  to `telemetry_spans`? Is the strict read-only stance preserved on the migrated PG store?
- [ ] **E-10:** If the marker is present but the PG store was wiped/recreated externally, does the
  next startup detect the missing data and re-run, or trust the marker and boot on an empty store?
- [ ] **E-11:** Does a backout run against a snapshot taken on a different schema version (a table
  added/removed since) restore cleanly, or fail with a structured error?
- [ ] **E-12:** Does the export ever block on the shared pool under concurrent live traffic (Mission
  Monitor streaming rows during the cutover)? Any deadlock or connection exhaustion?
- [ ] **E-13 (console):** `tauri_read_logs(source="console")` after every probe — any `Error:` /
  `Uncaught` / `Maximum update depth exceeded` is a defect that invalidates that leg's evidence.
- [ ] **E-14:** After `dev-env.ps1 -Action Down`, is any `postgres.exe` left alive with no owning app
  (the #2948 teardown-orphan class)? Record PIDs + ports.
