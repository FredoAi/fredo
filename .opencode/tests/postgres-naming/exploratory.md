# postgres-naming — Exploratory

Unscripted edge/failure probes for the embedded-PostgreSQL cluster identity (application database
`fredo`, bootstrap role `postgres` UNCHANGED, one-time catalog-only no-data-loss migration) at issue
**#3036** and its following slices. A confirmed finding **promotes** to `functional.md` as a new
`F-` row (keep the origin note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running cluster/app under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); the named failure
> mode is the #2948 ~11 h `pg.stop()` hang. Never an unbounded run.

## Prompt lines

- [ ] **E-1:** What does the migration do when the legacy cluster (tables in the `postgres`
  database) is locked/held by a headless `fredo ingest` daemon at GUI boot — does it migrate before
  attach, defer, or fail closed with a clear message?
- [ ] **E-2:** Seed a legacy dir in which the target database `fredo` ALREADY exists (a partial
  prior migration / a stray `fredo` db) — is the second migration a byte-identical no-op, or does
  `ALTER DATABASE postgres RENAME TO fredo` error on the name collision?
- [ ] **E-3:** Interrupt the boot/migration around the single catalog `ALTER DATABASE postgres
  RENAME TO fredo` (Task-Manager kill) — does the next boot recover to a fully-migrated cluster
  with ALL rows intact, or leave a half-renamed state?
- [ ] **E-4:** With a migrated cluster, does the built-in PostgreSQL client's saved connection (its
  default db/user) still connect, or does it retain a stale `postgres` DATABASE default?
- [ ] **E-5:** Does a legacy `FREDO_PG_PASSWORD_FILE` / keychain credential still authenticate after
  the database rename (the role `postgres` and the keychain identity `fredo.postgres` are
  UNCHANGED), or is a re-key required?
- [ ] **E-6:** Rename the cluster database while an external `psql` holds a session to the
  `postgres` database — PostgreSQL requires no other sessions to the database being renamed; what
  happens to that session, and does the app stay usable / fail closed with a clear message?
- [ ] **E-7:** Copy a migrated data dir to a different machine path and boot — does the identity
  resolve (no absolute-path assumption in the cluster catalog)?
- [ ] **E-8:** Does the `telemetry-query` skill with NO explicit `-PgUser`/`-PgDatabase` read the
  `fredo` db default and the `postgres` user default, or does it silently fall back to the
  `postgres` DATABASE?
- [ ] **E-9:** With the migration done, does the reconciled `max_connections` overlay stay at 12
  across a full app restart, or does a fresh overlay re-pin an old value?
- [ ] **E-10:** What happens on a legacy dir that also contains a pre-existing user database named
  `fredo` (name collision with the target db)?
