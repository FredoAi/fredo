# application-data — Exploratory

Unscripted edge/failure probes for the application-data storage layer's dynamic-identifier surface
(issue #3075). A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin
note). The Tester adds probes below beyond the script.

> **Verification policy: static** — probes are unit/gated-PG level; a probe that would need the running
> app must say so explicitly and name the live lever. **G-263 SAFETY:** the gated PG suite is bounded
> and torn down by `PgRuntime` RAII; never a bare `postgres`/`pg_ctl`; never an unbounded run.

## Prompt lines

- [ ] **E-1:** Is a physical column name containing a double quote (`a"b`) or a non-ASCII character
  orderable? Does `quote_ident` double embedded quotes and does the physical-column check still match?
- [ ] **E-2:** What does a payload that is a valid column but with a trailing NUL / control character
  (`id\0`, `id\tDESC`) do — a typed rejection, or a token-splitting surprise?
- [ ] **E-3:** Does a `where_cols` key with a mixed-case physical column (`latestAt`) bind and match,
  or is it rejected as unknown (case-sensitivity of the physical-column check)?
- [ ] **E-4:** Is `validate_identifier_charset` applied to BOTH `application_id` and `table_name`, and
  does a hyphen-only id (`-`, `--`) or a leading digit behave as documented?
- [ ] **E-5:** Does the `LIMIT` path remain unaffected by the identifier hardening, and can a huge
  `limit` or a `limit: 0` reach PostgreSQL without a new error?
- [ ] **E-6:** Under a concurrent `query` + `update` on the same table, does a rejected `order_by`/
  `where_cols` leave the shared pool usable for the next valid call (no poisoned connection)?
- [ ] **E-7:** Does a `where_cols` value of `null` / a JSON object / an array bind cleanly for a TEXT
  vs INTEGER vs BLOB affinity column, or produce a type error at the pool?
- [ ] **E-8 (console):** after a gated PG run, `tauri_read_logs(source="console")` — any `Error:` /
  `Uncaught` is a defect that invalidates that leg's evidence.
