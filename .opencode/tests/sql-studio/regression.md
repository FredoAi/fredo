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

## Resize-slice baseline (#3049)

The "must not change" set for the resize slice. Resizing is **additive**: it changes split SIZES
only — every pane's content, the query capability, the settings document and the default layout
stay frozen. Links point at the cases that already cover each invariant.

- [ ] **R-X (pane content unchanged):** the connection list, schema tree, schema inspector,
  history panel, saved-queries panel and results grid still render their content; a resize changes
  geometry only, never which content is shown. Overlaps `sql-studio F-1..F-12` /
  `db-client-builtin regression.md` / `postgres-client functional.md`.
  **FAIL** = a pane's content is dropped or altered by a resize.
- [ ] **R-XI (query capability / workspace toolbar unchanged):** the multi-tab query workspace
  (independent tab text/result state), Run / Run-all, destructive-confirm gate, export menu and
  history append behave exactly as before. Resize handles (S3) must not steal clicks from, or
  overlap, the tab strip / Run controls. Overlaps `postgres-client F-5`, `sql-studio F-8/F-9`.
  **FAIL** = a query-workspace control is broken, unreachable, or overlapped by a divider.
- [ ] **R-XII (schema-inspector `height="35%"` box preserved):** when a schema node is selected,
  the inspector still renders in its `height="35%"` / `minHeight="120px"` box (with its top border).
  The S4 split resizes the connections↔schema area WITHOUT removing or collapsing the inspector.
  **FAIL** = the inspector box is gone, permanently collapsed, or broken by S4.
- [ ] **R-XIII (`Fredo_dbclient_prefs` settings document preserved):** the KV key stays
  `Fredo_dbclient_prefs` and still round-trips `defaultRowLimit` / `pageSize` / `confirmDestructive`;
  the unified settings Save still works; any new layout preference EXTENDS this document without
  corrupting the existing fields, and a corrupt/out-of-range value degrades to defaults (tolerant,
  R-4.5 — see `sql-studio F-33`). Overlaps `postgres-client` settings case.
  **FAIL** = a renamed/lost key, a lost existing preference, or a settings-save regression.
- [ ] **R-XIV (layout regions + default sizes unchanged on first run):** the 3-region layout
  (left column, centre workspace, right column) + the bottom live-status region remain; with NO
  persisted layout (fresh profile), the split sizes default to the prior fixed sizes (left 300px,
  right 280px, inspector 35%) so first-run looks unchanged. Overlaps `sql-studio R-V`.
  **FAIL** = a missing region or a shifted default layout on first run.
- [ ] **R-XV (build gates + no cross-app imports):** re-run R-VIII (`pnpm --filter @fredo/ui build`
  zero TS errors, `pnpm test` green; `cargo check` N/A unless Rust touched) and R-IX (no
  cross-application import). **FAIL** = any TS error, failing test, or cross-app import.

## Schema-explorer actions submenu baseline (#3050)

The submenu is **additive**: it must not alter schema-tree navigation, the inspector, the
query-workspace controls, or the read-only gates. Links point at the cases that already cover each
invariant.

- [ ] **R-XVI (schema-tree navigation unchanged):** left-click still selects the node
  (`aria-selected` + inspector update); the `db-schema-toggle` chevron still only
  expands/collapses via its `event.stopPropagation()` (`SchemaTree.tsx:222-225`) and never opens
  the actions menu; lazy per-level loading, inline errors and Retry are unchanged. Overlaps
  `sql-studio F-34/F-46`, `postgres-client` schema cases.
  **FAIL** = selection broken, or the chevron opening the menu.
- [ ] **R-XVII (inspector unchanged):** selecting a node still renders
  `db-schema-inspector[data-inspected-id]` in its `height="35%"` box; "View columns" is
  behaviour-identical to a plain select (no spurious tab/execute). Overlaps `sql-studio F-40`,
  `R-XII`.
  **FAIL** = the inspector box/content changed.
- [ ] **R-XVIII (query workspace + read-only gates unchanged):** the multi-tab workspace (independent
  tab text/result state), Run / Run-all, destructive-confirm gate, export menu and history append
  behave exactly as before; "Open table data" issues ONLY a `SELECT` and the read-only default +
  `readOnlyBlocked` enforcement are untouched (`DEFAULT_ACCESS_MODE = ReadOnly`). Overlaps
  `sql-studio F-42`, `R-III`, `postgres-client F-5`.
  **FAIL** = a broken workspace control, a non-SELECT statement, or a changed read-only gate.
- [ ] **R-XIX (default row limit preference preserved):** `Fredo_dbclient_prefs` still round-trips
  `defaultRowLimit` / `pageSize` / `confirmDestructive`; the new SQL uses the stored value with no
  new hardcoded limit. Overlaps `R-XIII`, `sql-studio F-37`.
  **FAIL** = a lost/renamed preference or a hardcoded LIMIT.
- [ ] **R-XX (build gates + no cross-app imports):** re-run `R-VIII` / `R-IX` for the #3050 change.
  **FAIL** = any TS error, failing test, or cross-app import.

## Notes

- The rename is a UI-identity change ONLY: every engine, command, id, testid, and enforcement
  contract above stays frozen. The durable contract is the "app identity = SQL Studio, engine
  identity = PostgreSQL" split; a future spec touching the same surface inherits this suite.

## Run log

### Round 1 — 2026-10-13 (spec/3048 @ bc741d6) — Verdict: **PASS**

R-1..R-4 (inherited overlapping surface) and R-I..R-IX all PASS live. R-I engine strings
(`PostgreSQL 18.6`, role `postgres`, db `fredo`) unchanged; R-II `database-client` id + `db_*`
commands unchanged; R-III read-only default + `readOnlyBlocked` refusal confirmed; R-VII
`AccessModeBadge.tsx` + its test absent; R-VIII build 0 TS errors + 212/2690 tests green; R-IX diff
scoped to `database-client/**` + 2 docs (no cross-app import, no Rust change).
