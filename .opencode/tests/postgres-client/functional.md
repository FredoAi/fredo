# postgres-client — Functional

Durable functional suite for the **built-in PostgreSQL client** feature domain (named saved
connections, schema browser, SQL editor, history/saved queries, CSV/JSON export, read/write
safety, secure credentials). Seeded at issue **#2950**. Inherited and extended by every
following slice that touches the Postgres client surface.

> **Verification policy: LIVE** — every case observes a running app: a live connection, a
> live schema tree, live query results, live error/refusal behaviour, and live credential
> secrecy. The testing exit gate and audit fail-closed unless the Tester's Evidence
> references a live receipt — a `telemetry_spans` query (row-pipeline / Mission-Monitor side)
> AND a managed-`psql` PG read (the client's own DB side). A static-only PASS is a FALSE PASS.

> **G-284 READ LEVER:** the `telemetry-query` skill is SQLite-only. Every PG read
> (fixture verification, `\d` schema cross-check, row-limit / no-multi-statement /
> read-only-unchanged proofs) uses the managed `psql` via the allowlisted wrapper
> `run-exitcode.ps1 -Command "<psql> <uri> …"`, database `postgres` (NOT `fredo`); the
> connection URI comes from `pg_supervisor_status` and the password from the
> `postgres.password` AppStore key. `telemetry_spans` is used only for the row-pipeline /
> Mission-Monitor receipt.

> **G-263 SAFETY:** never run an unbounded binary. The test PG instance is the app's embedded
> PG (reused), started/stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2950` / `-Action Down`.
> Every managed-`psql` command is time-bounded (≤60 s). Bounds: connect ≤10 s; app start
> ≤180 s / stop ≤30 s.

> **G-275 INDUCTION:** AC1 failure paths are induced with real external conditions — closed
> loopback `127.0.0.1:1`, non-routable TEST-NET `192.0.2.1:5432`, wrong password, SSL
> mismatch — with assets under `.opencode/tmp/2950/`. The binding product seam is
> `FREDO_DBCLIENT_FORCE_FAIL` (`connect|auth|timeout|query`, inert when unset) with the
> writable state dir `FREDO_DBCLIENT_STATE_DIR` (default `.opencode/tmp/2950/dbclient/`); the
> unreachable-server/timeout leg binds to `FREDO_DBCLIENT_FORCE_FAIL=timeout`. Server-side PG
> seams `FREDO_PG_DATA_DIR` / `FREDO_PG_POOL_FORCE_FAIL` remain available.

> **BINDING CONTRACT (G-023a/G-255):** the Architect's authoritative names block is published
> and adopted — UI feature id `database-client`, DOM/testid prefix `db-`, wire types `Db*`,
> commands `db_*`, credential = OS-keychain handle (service `fredo.dbclient`). This suite's
> domain name stays `postgres-client` (matching the `**Feature tests:**` token and folder).

## Cases

- [ ] **F-1 (AC1 / QA-1) — connect, test-before-save, persist across restart.**
  Live boot → open the Postgres client surface → add `qa-local` (host/port/user/password/
  database/SSL from `pg_supervisor_status`) → click Test (success) → Save →
  `dev-env -Action Down` / `-Action Up` → reopen.
  **Expected:** valid Test succeeds; Save persists; after restart the connection is listed
  with identical non-secret fields and Test succeeds again. A bad-host Test returns a
  structured actionable error naming host/port and Save is refused.
  **FAIL** = not persisted, no test-before-save, panic/generic error, or unbounded wait.

- [ ] **F-2 (AC2 / QA-2) — schema tree browse.**
  Connect to the embedded PG (`postgres`); seed `qa_client` via bounded managed psql; expand
  databases → schemas → tables/views → columns+types / indexes / keys / functions; open a
  node; cross-check with `psql \d`.
  **Expected:** every node type listed and expandable; columns show correct data types;
  indexes/PK/FK/functions listed; a node opens to inspect; tree matches `\d`.
  **FAIL** = any node type missing, wrong type, or non-expandable node.

- [ ] **F-3 (AC3 / QA-3) — query editor + results.**
  Open ≥2 tabs; run a whole statement and a selection; run a multi-statement batch; run a
  broken statement; sort/scroll; verify default row limit + Load more; trigger autocomplete
  after `SELECT * FROM ` and `t.`.
  **Expected:** each tab keeps its own text/results; whole-vs-selection runs the right SQL;
  each result set in its own grid; error shows message + position/line; grid sortable +
  scrollable; first page = default limit; Load more appends with no dup/gap; autocomplete
  lists tables then columns. **FAIL** = tab cross-contamination, wrong run target, missing
  error position, no limit/Load more, or frozen UI.

- [ ] **F-4 (AC4 / QA-4) — history, saved queries, CSV + JSON export.**
  Run several statements; browse per-connection history; re-run one; save a named query;
  reload after restart; export a result grid to CSV and to JSON.
  **Expected:** history is per-connection and ordered; re-run reproduces query/results; saved
  named query reloads exactly and survives restart; CSV header + rows match the grid and JSON
  keys + values match the grid.
  **FAIL** = history shared across connections, saved query lost, or export mismatch.

- [ ] **F-5 (AC5 / QA-5) — destructive warning + confirmation.**
  In write mode run UPDATE/DELETE/DROP/TRUNCATE/ALTER → warning+confirm; cancel, then confirm.
  **Expected:** a warning appears; the statement does NOT run unless confirmed; confirm
  executes exactly once. **FAIL** = any destructive statement runs unconfirmed.

- [ ] **F-6 (AC1 / QA-6, G-275) — actionable connection errors.**
  Induce bad host (`127.0.0.1:1`), unreachable server (TEST-NET `192.0.2.1:5432`), bad
  credentials (wrong password), SSL mismatch; assets under `.opencode/tmp/2950/`.
  **Expected:** each returns a structured, actionable error within the hard connect bound
  (≤10 s); no hang, no panic, no secret in the message; a failed connection is not saved.
  **FAIL** = hang, unstructured panic, or a saved failed connection.

- [ ] **F-7 (AC3 / QA-7, G-263) — bounded results + Load more + no freeze.**
  Seed `qa_big` (≥5,000 rows) via bounded managed psql; run `SELECT * FROM qa_big`; measure
  first-page rows + render time; click Load more; probe interactivity while the grid is full.
  **Expected:** first page = the declared default limit (not the full table); Load more
  appends the next page with no gap/dup; UI stays interactive (no freeze beyond a declared
  bound, e.g. 2 s) and the grid scrolls/virtualizes.
  **FAIL** = full table dumped, no Load more, or a freeze.

- [ ] **F-8 (AC5 / QA-8) — no silent multi-statement.**
  Submit one action containing two `;`-separated statements (and a CTE-wrapped DML variant)
  with a sentinel side effect.
  **Expected:** only the first statement executes, or the action is refused with a clear
  message; the second statement's side effect is absent (managed-psql read).
  **FAIL** = the second statement runs.

- [ ] **F-9 (AC5 / QA-9) — read-only never executes destructive.**
  Open a read-only connection; submit UPDATE/DELETE/DROP/TRUNCATE/ALTER one at a time.
  **Expected:** every statement is refused before execution; a managed-psql read confirms the
  target data is unchanged. **FAIL** = any statement executes.

- [ ] **F-10 (AC5 / QA-10) — credential secrecy.**
  Set a unique sentinel password on a saved connection; search the repo working tree, the app
  console log (`tauri_read_logs`), the connection store artifact, and a CSV export for the
  sentinel.
  **Expected:** the sentinel appears in NONE of repo / logs / exports; the named credential
  store does not expose it in cleartext at a repo/log/export-reachable path.
  **FAIL** = sentinel found in any surface.

- [ ] **F-11 (human MISSION-MONITOR TESTING DIRECTIVE / QA-11) — Mission Monitor E2E (LIVE).**
  Boot on the PG-default path (`dev-env -Action Up -Spec 2950`); drive a live agent session
  (Run CLI or an active companion generation) so OTLP spans ingest; open Mission Monitor and
  confirm live sessions/tools/tokens; then open the Postgres client and connect + browse +
  query live. Cross-check `telemetry_spans` and the managed-psql PG read at the same instant.
  **Expected:** app boots on PG default; Mission Monitor renders the live session and its
  tools/tokens from classified rows; `telemetry_spans` returns the landed rows at the same
  instant; the Postgres client is reachable and functional live.
  **This leg applies to this slice AND every following Postgres slice.** A static-only
  receipt = FALSE PASS.

- [ ] **F-12 (AC-settings / QA-12) — auto-discovered settings surface.**
  Confirm the feature registers via `registerFeature`; open its settings surface; change a
  setting (e.g. default row limit); restart and observe.
  **Expected:** the feature appears on the settings surface without a manual central-list
  edit; the setting persists and takes effect. **FAIL** = manual registration or no effect.

- [ ] **F-13 (NFR / QA-13, G-263) — bounded external runtime.**
  Inspect every external command (managed-psql seed/cross-check, `dev-env Up/Down`).
  **Expected:** no unbounded command; the postmaster is started/stopped only via `dev-env`;
  every psql invocation has a hard bound (≤60 s) and a receipt.
  **FAIL** = an unbounded run or a bare `postgres`/`pg_ctl`/`psql` spawn.

- [ ] **F-14 (NFR / QA-14) — dropped-connection recovery.**
  With a connection open and a grid shown, kill the postmaster (bounded `dev-env -Action Down`
  or managed-psql stop), attempt another query, then restart.
  **Expected:** a clear connection-lost state (not a silent hang/blank); the UI stays
  responsive; reconnect/retry recovers without losing saved connections/history.
  **FAIL** = hang, panic, or lost saved state.

- [ ] **F-15 (NFR / QA-15) — deterministic load.**
  Restart the app 3× and reopen the client.
  **Expected:** identical set and stable ordering of saved connections and history each boot;
  no duplicates, no lost entries. **FAIL** = nondeterministic order, duplicates, or loss.

## Server-side read-only hardening (#3080)

Slice on top of #2950/#3029. PostgreSQL itself enforces read-only: for a `ReadOnly` connection
the pool applies `SET default_transaction_read_only = on` per **physical** connection via
`PgPoolOptions::after_connect` (`applications/db_client/connect.rs`), and `COPY`/`GRANT`/`REVOKE`/
`SECURITY` move to `StatementClass::Destructive` (`classify.rs`). Layer 1 (the client-side
`readOnlyBlocked` gate, `query.rs:103-115`) is unchanged and KEPT.

> **Verification policy: LIVE.** AC1 ("the server rejects the statement") and AC2 ("applied only
> to read-only connections and survives pool reconnects") are runtime properties of a live
> PostgreSQL. **Live receipt = a live webview DOM/screenshot** (`tauri_webview_screenshot` +
> `tauri_webview_dom_snapshot`): this change emits **no OTLP spans**, so a `telemetry_spans`
> receipt is NOT producible by it — never fabricate one via `fredo emit` (G-256).

> **G-263 SAFETY:** bounded legs; the app is started/stopped only via
> `.opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3080`; managed-`psql` ≤60 s; connect ≤10 s.

> **INDUCTION LEVERS (G-275/G-300):** `FREDO_DBCLIENT_STATE_DIR=<seeded dir>` supplies a
> read-write connection; `FREDO_DBCLIENT_FORCE_FAIL=connect|auth|timeout|query` (inert when unset);
> the reconnect lever is a bounded managed-`psql` `SELECT pg_terminate_backend(<app backend pid>)`.

- [ ] **F-16 (AC1 / R-1.1) — read-only session reports `on`.**
  Connect the built-in **"Fredo"** row (ReadOnly, `postgres` superuser); run
  `SHOW default_transaction_read_only;` (classifies `Read`).
  **Expected:** the result grid shows exactly **`on`**; live DOM + screenshot captured.
  **Edge:** the ReadWrite leg shows **`off`**; the transient test-before-save probe (no access
  mode) is unaffected. **FAIL** = anything other than `on` on the read-only session.

- [ ] **F-17 (AC1 / R-1.2) — the server rejects a `Read`-classified volatile write (BINDING).**
  On the read-only session run `SELECT * FROM chat_rows LIMIT 1 FOR UPDATE;` (classifies `Read`);
  secondary: `SELECT nextval('qa_3080_seq');` (create `qa_3080_seq` read-write first).
  **Expected:** a typed **`query`** error whose message carries SQLSTATE **`25006`**
  ("read-only transaction"); **no** write performed (a managed-`psql` read confirms no side
  effect). **Edge:** empty `chat_rows` still errors (plan-time rejection); `FOR SHARE`.
  **FAIL** = the statement executes on the read-only connection.

- [ ] **F-18 (AC1 caveat / R-1.2) — RECORD the four AC1-named statements' outcomes.**
  On the read-only session run each and **record error-or-success + message**: (a)
  `SELECT pg_terminate_backend(0);` (b) `SELECT set_config('default_transaction_read_only','off',false);`
  (c) `SELECT lo_import('.opencode/tmp/3080/lo.txt');` (d) `SELECT nextval('qa_3080_seq');`.
  **Expected (recorded, NOT asserted):** (a)/(b) **pass through** (PostgreSQL carries no
  `XactReadOnly` guard); (c)/(d) rejected `25006`. AC1's named list is **illustrative ("e.g.")** —
  F-17 is the binding evidence. **Edge:** pid `0` so nothing is killed; **disconnect + reconnect
  after (b)** (the hook re-applies `on`). (a)/(b) passing through is a **residual → follow-up**,
  not a FAIL of this slice. **FAIL** = (c)/(d) not rejected, or a write performed by (c).

- [ ] **F-19 (AC1 / R-1.3) — layer 1 unchanged.**
  Read-only session: submit `INSERT`/`UPDATE`/`DELETE`/`DROP`/`COPY`/`GRANT`/`REVOKE`/`SECURITY`.
  **Expected:** **`readOnlyBlocked`** before any server contact; `tauri_ipc_monitor` shows the
  statement never reached the server; no `25006`. **Edge:** a batch whose first is `Read` and a
  later is non-`Read` → the whole call is refused. **FAIL** = a statement reaches the server.

- [ ] **F-20 (AC2 / R-2.1, R-2.3) — the hook survives a pool reconnect.**
  Verify `SHOW default_transaction_read_only` = `on`; force the physical connection to drop via a
  bounded managed-`psql` `SELECT pg_terminate_backend(<app backend pid>)`; re-query.
  **Expected:** the **replacement** connection still reports `on` and still rejects F-17's write.
  **Edge:** if a drop cannot be forced, key the row to the hook-at-build + `pg_stat_activity`
  evidence and **disclose** the substitution (never a static PASS). **FAIL** = the replacement
  reports `off` or a write executes.

- [ ] **F-21 (AC2 / R-2.2) — ReadWrite is byte-identical to today.**
  ReadWrite session: `SHOW default_transaction_read_only;`, then `INSERT`/`UPDATE`.
  **Expected:** **`off`**; writes execute; `min_connections(0)`/`max_connections(1)` and the
  destructive-confirmation gate unchanged. **Edge:** built-in edited to readWrite, or the
  `FREDO_DBCLIENT_STATE_DIR` seam with a hand-authored readWrite row. **FAIL** = `on`, or a
  changed write/confirmation path.

- [ ] **F-22 (AC3 / R-3.1..R-3.4) — reclassification + gate consequences (unit pin).**
  Pin `COPY`/`GRANT`/`REVOKE`/`SECURITY` → `Destructive`; on a ReadWrite state they yield
  `confirmationRequired` (echo the hash → gate passes); on a ReadOnly state they yield
  `readOnlyBlocked`; `ALTER` stays `Destructive`, `INSERT` stays `Write`.
  **FAIL** = a reclassified statement keeps `Write`/`Ddl`, or the gate consequences differ.

- [ ] **F-23 (AC4 / R-4) — test churn handled.**
  `cargo nextest run`: the moved `tests_classify.rs` cases + extended `tests_query.rs` cases are
  green and every pre-existing db_client test stays green. **FAIL** = a stale assertion or a red
  test.

- [ ] **F-24 (AC5 / R-5) — build hygiene.**
  `cargo check` (from `apps/tauri/src-tauri/`) + `cargo nextest run`.
  **Expected:** **zero warnings, no `#[allow(...)]`**; nextest green; `FREDO_TEST_PG`-gated
  integration binaries are no-ops without the env. **FAIL** = any warning or failure.

## Suite-level pass/fail

PASS = F-1..F-15 all green. Any unbounded external command; a destructive statement executed
without confirmation; a read-only connection executing a destructive statement; a single
action executing more than one statement; a plaintext credential sentinel in repo/logs/export;
an unbounded result grid with no default row limit or Load more; Mission Monitor blank while
live/stored rows exist = **FAIL**. UNVERIFIED rows (no reachable induction lever) are not
PASS — the verdict fails closed (G-033).

For the **#3080 slice**, PASS additionally requires **F-16..F-24** all green, with **F-17**
(binding: a read-classified volatile write → server `25006`) and **F-16** (`SHOW
default_transaction_read_only` = `on`) captured as live webview DOM/screenshot. A read-classified
volatile write that executes on the read-only connection; a read-only session reporting anything
but `on`; a ReadWrite session changed; a reclassified statement not `Destructive`; a
`readOnlyBlocked` statement reaching the server; or a `cargo check` warning = **FAIL**. **F-18**
is a RECORD row — a pass-through of `pg_terminate_backend`/`set_config` is PASS for this slice
(residual → follow-up); **F-22's wiring pin never alone satisfies AC1/AC2**. The live receipt is
a webview DOM/screenshot, **not** `telemetry_spans` (this change emits no spans).

## Round — #2950 (2026-10-02, round 2, `spec/2950 @ adc8760`) — PASS 15/15 + smoke 8/8

- **F-1..F-15 (QA-1..QA-15):** PASS live. Round-1 PASS rows re-confirmed; the round-2 fixes verified:
  - **F-12 (QA-12):** the stored `defaultRowLimit` now drives the first result page — Settings →
    PostgreSQL → 137 → Save → restart → `SELECT * FROM qa_big` = `Showing 137 rows`; set 150 →
    restart → `Showing 150 rows` (round 1 was a hardcoded 100 → FAIL).
  - **F-14 (QA-14):** killing the embedded postmaster mid-session now surfaces the typed
    `connectionLost` ("connection lost: the server is no longer reachable") and marks the
    connection disconnected (round 1 surfaced `timeout` and stayed "connected").
  - **F-3 (QA-3):** the autocomplete duplicate-key React console warning is gone (two same-named
    columns render with no warning).
- **Live receipts:** managed-`psql` PG reads (`max_connections=100` untuned baseline, see verdict
  caveat) + webview DOM/screenshots + `telemetry_spans` (session `ses_f019b4335ffe017iyGOEEkdk4u`,
  4 spans / 2 chat / 1 tool; MM rendered `TOOLS (1)` + RESPONSE + TOTAL 24,273).
- **Environment (disclosed, not a spec defect):** embedded-PG `max_connections=8` contention and an
  orphaned postmaster/`:9223` socket across `dev-env -Action Down`; remedied with the FS-5 untuned
  data dir + a bounded orphan kill.
