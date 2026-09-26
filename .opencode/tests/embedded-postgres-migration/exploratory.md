# embedded-postgres-migration — Exploratory

Unscripted probes for the migration-approach spike (#2964). A confirmed finding **promotes**
to `functional.md` as a new `F-` row (keep the origin note). The Tester adds probes below
beyond the script.

Verification policy: **static** — probes inspect the deliverable files and (if a PoC exists)
its bounded execution. No `telemetry_spans` query applies.

## Prompt lines

- [ ] **E-1:** Does the schema mapping silently drop a SQLite-specific behavior the product
  relies on — upsert (`ON CONFLICT`), WAL, `synchronous`, `AUTOINCREMENT`, `TEXT` affinity,
  or boolean-as-integer? Pick one store and trace a concrete column.
- [ ] **E-2:** Does the store/module migration address the ~30 ms write-behind queue and LRU
  cache semantics in `infrastructure/rtdb/store.rs`, or only the SQL calls? A path that
  changes the flush/coalescing contract is a hidden production change.
- [ ] **E-3:** Does the data-migration section handle the `rtdb.backfill.completed` marker
  and the provider `.v2` marker so a re-run does not duplicate or race backfill work?
- [ ] **E-4:** Does the startup/lifecycle design actually bound the `pg.stop()` hang (finite
  stop + kill fallback), or merely acknowledge it? Probe the PoC's timeout/panic path.
- [ ] **E-5:** Is the `bundled` acquisition mode considered with its real offline/compile
  implications, or hand-waved as "no network needed"?
- [ ] **E-6:** Is the rollback path executable from the post-cutover state (SQLite file +
  migration version still present), or does it assume the old engine is still installed?
- [ ] **E-7:** Do the open questions each carry a resolving evidence artifact, or are they
  restatements of the scope?
- [ ] **E-8:** Does any PoC leak PG runtime files into a tracked path, leave a stale data
  dir, or re-download binaries per run (idempotency / hygiene)? Check for orphan
  `postgres.exe` after an interrupted run.
- [ ] **E-9:** Does the deliverable quietly re-litigate "whether to migrate" (the explicit
  non-goal) instead of answering "how"?
