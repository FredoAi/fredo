# application-data — Functional

Durable functional suite for the **application-data storage layer's dynamic-identifier surface** —
the generic `DynamicTableStore` (formerly `ApplicationStore`) sink plus the declared-table
read/watch/write layer (`infrastructure/application_data/`). Seeded at issue **#3075**
(security hardening, Finding #1 of `research/34-security-audit-2026-10-22.md`).

> **Verification policy: static.** Every case is provable without a running Fredo app: the rejection
> surface is the pure `DynamicTableStore::{parse_order_by, order_by_sql, validate_where_columns,
> validate_identifier_charset}` + `validate_namespace` (typed `IdentifierError`), exercised by
> `cargo nextest run`; the deepest observable (a real PostgreSQL sink rejecting a payload / ordering by
> a quoted camelCase column) runs **in-process** through the committed gated integration binary
> `apps/tauri/src-tauri/tests/storage_engine_pg.rs` (embedded `PgRuntime`) — a test-harness receipt,
> **not** a running-app receipt. No AC requires driving the webview; the `application_store_query`
> `#[tauri::command]` is a thin `map_err(|e| e.to_string())` wrapper over `query`
> (`application_store.rs:849-867`), so its String-surface rejection is provable statically.

> **Gated-suite contract (G-263 / postgres-stores R-13):** `FREDO_TEST_PG=1` gates the PG binary — a
> plain `cargo nextest run` executes it as an immediate no-op (no server, no network, no
> `.opencode/tmp` writes). The real suite runs ONLY via
> `FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg`, against ONE embedded server
> (bounded start/stop; RAII `Drop` hard-kill). Never a bare `postgres`/`pg_ctl`.

> **Binding rejection surface (G-255):** `IdentifierError { InvalidOrderBy { order_by, reason },
> UnknownOrderColumn { column }, UnknownWhereColumn { column }, InvalidNamespaceIdentifier { kind,
> value } }` — `Display` + `std::error::Error`; surfaces as `String` at IPC (`to_errors`,
> `commands.rs:231`). The single quoting point is `order_by_sql` → `quote_ident(col) ASC|DESC`
> (`engine.rs:264-266`). `application_data/commands.rs::validated_order_by` (`:328-354`) stays bare
> (do NOT double-quote).

## Cases

- [ ] **F-1.1 (REQ-1.1) — statement terminator in `order_by` is rejected; no SQL executes.**
  Unit (`application_store.rs` `#[cfg(test)]`): `parse_order_by("<payload>", cols)` for
  `id; DROP TABLE feature_x`, `id;`, `id;--`, `id ;`, `id\n; DROP TABLE x`. Gated PG:
  `query(app, table, None, Some("<payload>"), None)`.
  **Expected:** `Err(IdentifierError::InvalidOrderBy { order_by, reason })` (a typed variant);
  `query` returns `Err`; **no SQL built/executed** — after the call the target table still resolves
  (`to_regclass('"feature_…"')` non-null) and its row count is unchanged. A `Display` string at the
  IPC boundary is the observable rejection. **FAIL** = `Ok`, or the table missing/rows changed.
  **Edge:** bare `id;`; `id;--` (comment); `id ;` (space before `;`); newline before `;`.

- [ ] **F-1.2 (REQ-1.2) — unbalanced paren / subquery in `order_by` is rejected; no SQL executes.**
  Unit + gated PG as F-1.1 for payloads `id)`, `id) DROP TABLE x`, `(SELECT 1)`,
  `id, (SELECT 1)`, `(SELECT pg_read_file('/etc/passwd'))`.
  **Expected:** `Err(IdentifierError)` — a typed variant (`InvalidOrderBy` for the multi-token shapes;
  `UnknownOrderColumn` for the single `id)` token); `query` Err; no SQL executes (table + row count
  unchanged). **FAIL** = `Ok` or any executed statement.
  **Edge:** single-token `id)`; multi-token `(SELECT 1)`; nested parens.

- [ ] **F-1.3 (REQ-1.3) — multi-column `order_by` is rejected; no SQL executes.**
  Unit + gated PG for `a, b` and `a,b`.
  **Expected:** `"a, b"` → `Err(InvalidOrderBy)` (2 whitespace tokens); `"a,b"` → `Err(UnknownOrderColumn)`
  (1 non-column token); both typed; no SQL. **FAIL** = `Ok`.
  **Edge:** trailing comma `a,`; spaced `a , b`.

- [ ] **F-1.4 (REQ-1.4) — unknown `order_by` column is rejected, naming the column.**
  Unit + gated PG for `nope` where `cols` = {`id`, `latestAt`, `last_active_at`, `_updated_at`}.
  **Expected:** `Err(UnknownOrderColumn { column: "nope" })`; `Display` names `nope`; `query` Err; no
  SQL. **FAIL** = `Ok`, or an error that does not name the column.
  **Edge:** case mismatch (`ID` vs physical `id` — the check is case-sensitive → `UnknownOrderColumn`);
  a reserved-looking `_row_version` absent from `cols`.

- [ ] **F-1.5 (REQ-1.5) — bad direction is rejected; valid ASC/DESC accepted (case-insensitive).**
  Unit for `id SIDEWAYS`, `id ASC`, `id asc`, `id DESC`, `id desc`, `id AsC`, `id ASC extra`.
  **Expected:** `SIDEWAYS`/`AsC`/3-token `id ASC extra` → `Err(InvalidOrderBy)`;
  `ASC`/`asc` → `Ok { descending: false }`; `DESC`/`desc` → `Ok { descending: true }`.
  **FAIL** = an unknown direction accepted, or a valid direction rejected.
  **Edge:** mixed case `AsC`; double space `id  DESC`.

- [ ] **F-1.6 (REQ-1.6) — absent / empty `order_by` emits no `ORDER BY` clause.**
  Gated PG `query(..., None, ...)`, `query(..., Some(""), ...)`, `query(..., Some("   "), ...)`; and
  unit-assert the built SQL string contains no `ORDER BY`.
  **Expected:** `None` and `Some("")` → the query runs with **no** `ORDER BY` (unaffected result set);
  `Some("   ")` → rejected with a typed `IdentifierError` (the non-empty guard admits it and
  `parse_order_by` sees 0 tokens) — never a bare `ORDER BY` / syntax error. **FAIL** = a bare
  `ORDER BY` reaching PostgreSQL, or a behavior change for `None`/`""`.
  **Edge:** `Some(" ")`; `Some("\t")` (whitespace-only → typed rejection, never a bare clause).

- [ ] **F-2.1 (REQ-2.1) — valid single-column ordering works, default ASC, direction case-insensitive.**
  Unit: `parse_order_by("id", cols)` → `Ok { column: "id", descending: false }`;
  `order_by_sql` → `"id" ASC`; `"id DESC"` → `"id" DESC`. Gated PG: insert 3 rows with distinct `id`,
  `query(..., Some("id ASC"))` / `Some("id DESC")`.
  **Expected:** the result set is ordered by that column in that direction; default (no direction) = ASC.
  **FAIL** = wrong order or a rejected valid form.
  **Edge:** `"id asc"` case-insensitive; default direction.

- [ ] **F-2.2 (REQ-2.2) — camelCase physical column (`latestAt`) orders via a QUOTED identifier (repairs `lifecycle.rs:211`).**
  Unit: `parse_order_by("latestAt", cols_with_latestAt)` → `Ok { column: "latestAt" }`;
  `order_by_sql` → `"latestAt" ASC` (quoted, case-preserved). Gated PG: create a declared table with a
  quoted `latestAt` column via `ensure_table`, insert rows with distinct `latestAt`,
  `query(..., Some("latestAt ASC"))`.
  **Expected:** the result set is ordered by the physical camelCase column. **FAIL** = the unquoted
  `ORDER BY latestAt` fold-to-`latestat` error (`column "latestat" does not exist`), or the wrong order.
  **Edge:** `"latestAt DESC"`; a lowercase `"latestat"` payload → `UnknownOrderColumn` (physical column
  is case-sensitive `latestAt`).

- [ ] **F-2.3 (REQ-2.3) — every verified caller accepted; `None` callers unaffected.**
  (a) Declared read: `validated_order_by(decl, Some("field DESC"))` → `Some("field DESC")` → sink
  accepts and orders (gated PG). (b) Retention prune: `query(..., Some("latestAt ASC"))` and
  `Some("_updated_at ASC")` (`lifecycle.rs:57,59`). (c) Terminal `list`:
  `query(..., Some("last_active_at DESC"))` (`applications/terminal/persistence.rs:138`).
  (d) `None` callers: projection (`projection.rs:536-540`), doom save (`save.rs:508-515`), registry
  (`registry.rs:615`), watch snapshot (`commands.rs:543-547`).
  **Expected:** each non-`None` caller's string is accepted and orders correctly; each `None` caller is
  unaffected (returns its rows with no `ORDER BY`, no error). **FAIL** = any verified caller rejected,
  or a `None` caller's behavior changed.
  **Edge:** `_updated_at` fallback when the declared table has no `latestAt`; empty declared table;
  `None` combined with `where_cols`.

- [ ] **F-3.1 (REQ-3.1) — `validate_namespace` / charset gate rejects out-of-charset and empty identifiers.**
  Unit: `validate_identifier_charset("applicationId", v)` and `validate_namespace(app, table)` for
  `"a b"`, `"app;drop"`, `"app\""`, `""`, `"app.dot"`, `"app/slash"`.
  **Expected:** each → `Err(InvalidNamespaceIdentifier { kind, value })`; `"mission-monitor"`,
  `"app_1"`, `"App-2"` → `Ok`. **FAIL** = an out-of-charset/empty identifier accepted.
  **Edge:** empty `application_id`; empty `table_name`; hyphen (allowed) vs dot/space/slash (rejected);
  non-ASCII.

- [ ] **F-3.2 (REQ-3.2) — in-use ids/tables resolve to their byte-identical full table names.**
  Unit (extends the frozen test `application_store.rs:902-929`): `full_table_name` / `validate_namespace`
  for `mission-monitor`/`sessions` → `feature_mission_monitor_sessions`; `doom`/`save` →
  `feature_doom_save`; `terminal`/`sessions` → `feature_terminal_sessions`
  (`LEGACY_TERMINAL_SESSIONS_TABLE`); `deleted_sessions`/`terminal_sessions` names.
  **Expected:** byte-identical to the shipped generator; the frozen unit test stays green.
  **FAIL** = any name drift (e.g. a lost hyphen→`_` sanitization).

- [ ] **F-4.1 (REQ-4.1) — unknown `where_cols` key is rejected, naming the column; no SQL executes.**
  Unit: `validate_where_columns({"nope": 1}, cols)` → `Err(UnknownWhereColumn { column: "nope" })`.
  Gated PG: `query(app, table, Some({"nope": …}), None, None)` (and `update`/`delete` with the key).
  **Expected:** typed `UnknownWhereColumn`; `Display` names `nope`; `query`/`update`/`delete` Err; no SQL
  executes (table + row count unchanged). **FAIL** = `Ok` or an executed statement.
  **Edge:** empty where map → `Ok` (no-op); multiple keys with one unknown; case-mismatched key.

- [ ] **F-4.2 (REQ-4.2) — valid `where_cols` keys bind as parameters (values never interpolated).**
  Unit: `validate_where_columns({"id": 1}, cols)` → `Ok`. Gated PG:
  `query(app, table, Some({"id": "a"}), None, None)` returns the matching row; `update`/`delete` with a
  valid key act on the matching row.
  **Expected:** the value is bound as `$n` (a value containing SQL metacharacters —
  `"a'; DROP TABLE feature_x --"` — is matched literally, no injection). **FAIL** = a value interpolated
  into the SQL text, or a matching row not returned.
  **Edge:** value with quotes/`;`; multiple valid keys ANDed; INTEGER/BLOB affinity values.

- [ ] **F-5.1 (REQ-5.1) — Rust identifiers renamed; frozen on-disk/DB contracts byte-identical.**
  Static pins + grep: `LEGACY_TABLE_PREFIX == "feature"`,
  `LEGACY_TERMINAL_SESSIONS_TABLE == "feature_terminal_sessions"`,
  `LEGACY_META_TABLES_TABLE == "feature_data_tables"`,
  `LEGACY_META_TOMBSTONES_TABLE == "feature_data_tombstones"`,
  `LEGACY_METADATA_COLUMN == "feature_id"` (`store.rs:39-44`), the `settings` table name; no `AppStore` /
  `ApplicationStore` **type** identifiers remain (only `SettingsStore` / `DynamicTableStore`);
  `#[tauri::command]` fn names `application_store_*` / `application_data_*` unchanged;
  `ApplicationDataStore` unchanged; module path `infrastructure/application_data/` unchanged.
  **Expected:** frozen literals byte-identical; renamed identifiers present; wire contract intact; the
  `frozen_metadata_literals_are_pinned` + byte-identical tests green. **FAIL** = any frozen literal
  drift, a surviving old type name, or a renamed Tauri command.

- [ ] **F-5.2 (REQ-5.2) — build gates: `cargo check` zero warnings + `cargo nextest run` green + gated PG suite green.**
  Run from `apps/tauri/src-tauri/`: `cargo check`; `cargo nextest run`; and
  `FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg`.
  **Expected:** `cargo check` zero warnings (no `#[allow(...)]`); `cargo nextest run` green with the
  existing `application_store` + `application_data` suites; the gated PG suite green with retention-prune
  and terminal-`list` ordering intact. **FAIL** = any warning, a red test, or a red gated suite.

## Non-functional

- [ ] **N-1 (zero warnings):** `cargo check` from `apps/tauri/src-tauri/` reports 0 warnings; no
  `#[allow(...)]` added anywhere (REQ-5.2).
- [ ] **N-2 (no new dependency):** `apps/tauri/src-tauri/Cargo.toml` dependency set unchanged.
- [ ] **N-3 (no behavior change for absent `order_by`):** F-1.6 holds; `None` callers unaffected
  (F-2.3).
- [ ] **N-4 (ordering preserved):** retention prune + terminal `list` ordering intact (F-2.3, gated PG).
- [ ] **N-5 (gated suite stays offline by default):** a plain `cargo nextest run` runs the PG binary as
  a no-op; the real suite runs ONLY with `FREDO_TEST_PG=1` (postgres-stores R-13/R-14).

## Suite-level pass/fail

PASS = F-1.1..F-5.2 all green with N-1..N-5 holding. Any injection payload accepted, any SQL executed
by a rejected payload, any frozen literal drift, any verified caller rejected, any `None` caller
affected, any warning, or a red gate = **FAIL**.
