# application-data — Regression

> "Must not change" baseline for the **application-data storage layer's dynamic-identifier surface**
> (issue #3075). These invariants MUST hold after the change — any FAIL is a regression. Run on every
> testing phase that touches the storage/application-data layer.
>
> **Verification policy: static** — the invariants are pinned by unit tests + the gated in-process PG
> integration binary (`storage_engine_pg.rs`), not by observing a running app. A static-only verdict is
> legitimate for this spec (backend-only hardening, no telemetry/UI).

## Must NOT change (regression invariants)

- [ ] **R-1 (frozen on-disk/DB contracts byte-identical):** `LEGACY_TABLE_PREFIX == "feature"`,
  `LEGACY_TERMINAL_SESSIONS_TABLE == "feature_terminal_sessions"`, `feature_data_tables`,
  `feature_data_tombstones`, `feature_id`, and the `settings` table name are byte-identical. The
  `per_app_table_prefix_generator_is_byte_identical` + `frozen_metadata_literals_are_pinned` tests stay
  green. **Edge / FAIL:** any literal drift, or a lost hyphen→`_` sanitization.

- [ ] **R-2 (webview wire contract unchanged):** the `#[tauri::command]` fn names
  `application_store_{ensure_table,insert,query,update,delete}` and `application_data_*` are NOT
  renamed; the `QueryArgs`/`UpdateArgs`/`DeleteArgs` payload shapes are unchanged. **Edge / FAIL:** a
  renamed command or a payload field change.

- [ ] **R-3 (single quoting point — no double-quoting):** `application_data/commands.rs::validated_order_by`
  (`:328-354`) stays bare (`field ASC|DESC`); the sink (`order_by_sql` → `quote_ident`) is the ONLY
  quoting point. A caller that also quotes would break the sink's physical-column name check.
  **Edge / FAIL:** a second `quote_ident` applied to `order_by` upstream.

- [ ] **R-4 (absent/empty `order_by` unchanged):** `None` / `Some("")` emit no `ORDER BY` clause; no
  caller that passes no ordering changes behavior. **Edge / FAIL:** a new `ORDER BY` for a `None`
  caller, or a rejected `None`.

- [ ] **R-5 (`where_cols` values stay parameterized):** valid `where_cols` values bind as `$n`; no value
  is ever interpolated into the SQL text. **Edge / FAIL:** a value concatenated into the statement.

- [ ] **R-6 (retention prune + terminal `list` ordering intact):** the `latestAt ASC` /
  `_updated_at ASC` prune (`lifecycle.rs:57,59,206-213`) and the terminal `last_active_at DESC`
  (`persistence.rs:138`) still order correctly. **Edge / FAIL:** a prune/list ordering regression.

- [ ] **R-7 (gated PG suite stays OFFLINE by default):** `apps/tauri/src-tauri/tests/storage_engine_pg.rs`
  is gated behind `FREDO_TEST_PG=1`; a plain `cargo nextest run` executes it as an immediate no-op — no
  embedded server, no network, no `.opencode/tmp` writes. The real suite runs ONLY via
  `FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg`. **Edge / FAIL:** a gated test starting
  a server (or creating a data dir) without `FREDO_TEST_PG=1`, or a default run regressing to require PG.

- [ ] **R-8 (build gates):** `cargo check` (from `apps/tauri/src-tauri/`) zero warnings AND
  `cargo nextest run` green; no `#[allow(...)]`. **Edge / FAIL:** a warning or a red test.

- [ ] **R-9 (no new dependency):** `apps/tauri/src-tauri/Cargo.toml` dependency set unchanged.
  **Edge / FAIL:** a new crate added.

- [ ] **R-10 (architecture boundaries):** `tauri::async_runtime::spawn` (never `tokio::spawn`); no
  cross-application import; row-pipeline code stays in `infrastructure/rtdb/`. **Edge / FAIL:** a
  `tokio::spawn` or a feature→feature import.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-11:** inherit and run `.opencode/tests/postgres-stores/regression.md` (R-1..R-28) — the store
  engine seam + shared pool; R-13/R-14 pin the gated-suite offline/bounded contract, R-17 pins the
  declared-table identifier-quoting contract this spec extends.
- [ ] **R-12:** inherit and run `.opencode/tests/settings/` regression legs — the `settings` table name
  is a frozen contract (`AppStore`→`SettingsStore` rename must not drift it).
- [ ] **R-13:** inherit and run `.opencode/tests/terminal/` regression legs — the terminal `list`
  ordering (`last_active_at DESC`) is a verified caller.
