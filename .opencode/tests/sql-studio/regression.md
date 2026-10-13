# sql-studio — Regression

The "must not change" baseline for the SQL Studio identity + decluttered-shell slice. Every spec
touching the `database-client` surface re-runs these. Seeded at issue **#3048**.

> **Verification policy: LIVE** for the live rows; static pins noted where marked.

> **G-263 SAFETY:** every live leg is bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3048`.

## Inherited suites (overlapping surface)

- [ ] **R-1:** inherit and run `.opencode/tests/postgres-client/regression.md` + `functional.md` —
  the client's connect/schema/query/history/export + read-only safety + credential secrecy, which
  must stay byte-identical.
- [ ] **R-2:** inherit and run `.opencode/tests/db-client-builtin/regression.md` — the seeded
  built-in "Fredo" connection (`id="builtin-fredo"`), ordinary create/edit/delete, read-only
  default, and the `db_*` command set.
- [ ] **R-3:** inherit and run `.opencode/tests/postgres-naming/regression.md` — the
  embedded-cluster identity (engine strings, migration, `postgres` role) this rename must not touch.
- [ ] **R-4:** inherit and run `.opencode/tests/settings/regression.md` — the settings surface the
  app's auto-discovered section registers into.

## Must NOT change (regression invariants)

- [ ] **R-I (engine strings unchanged):** the engine/server-version strings stay verbatim —
  `serverVersion` renders e.g. "PostgreSQL 16.0"; the engine value is `postgres`; the DB role
  stays `postgres` and the application database stays `fredo`. Only the APP identity becomes
  "SQL Studio".
  **FAIL** = an engine/server-version string renamed or removed.
- [ ] **R-II (feature id + commands unchanged):** the UI feature id stays `database-client`, the
  DOM testid prefix stays `db-`, the wire types stay `Db*`, and the `db_*` / `pg_supervisor_status`
  command set is unchanged.
  **FAIL** = a renamed id/testid-prefix/wire type or a new/renamed command.
- [ ] **R-III (read-only default + enforcement unchanged):** a newly created connection still
  defaults to `accessMode=readOnly`; the rede-mode default resolves from the store, not the
  removed UI badge; every non-`read` statement on a read-only connection is refused
  `readOnlyBlocked` before server contact (managed-`psql` confirms no side effect).
  **FAIL** = the default changed, or a write executes.
- [ ] **R-IV (connect/disconnect flow unchanged):** connecting a saved connection still opens a
  live session and mounts the schema tree + query workspace; disconnect still tears the session
  down; connection-lost recovery is unchanged (`postgres-client F-14`).
  **FAIL** = a broken session open/teardown path.
- [ ] **R-V (no empty gap / layout intact):** the removed header strip leaves NO empty gap — the
  workspace reclaims the space; the 3-region layout (left 300px, centre flex, right 280px) and the
  bottom live-status region are unchanged.
  **FAIL** = an empty band where the strip was, or a broken region layout.
- [ ] **R-VI (no premature truncation, G-274):** the full-width connections list does NOT truncate
  the connection name / db-name; the ellipsis target is exactly `db-connection-name` /
  `db-connection-target`; exempt children (status dot, built-in badge, SSL label, action buttons)
  are not clipped.
  **FAIL** = premature ellipsis at the fit width, or a clipped exempt child.
- [ ] **R-VII (badge removal is complete):** `AccessModeBadge` component/export/test are retired
  and NOTHING else imported or depended on them.
  **FAIL** = a dangling import/export/test reference, or a build/test failure from the removal.
- [ ] **R-VIII (build gates):** `pnpm --filter @fredo/ui build` exits 0 with zero TS errors;
  `pnpm test` green. `cargo check` N/A unless a Rust file is touched (zero warnings if it is).
  **FAIL** = any TS error or failing test.
- [ ] **R-IX (no cross-application imports):** no cross-application import was introduced by the
  rename/restructure.
  **FAIL** = a cross-app import.

## Notes

- The rename is a UI-identity change ONLY: every engine, command, id, testid, and enforcement
  contract above stays frozen. The durable contract is the "app identity = SQL Studio, engine
  identity = PostgreSQL" split; a future spec touching the same surface inherits this suite.
