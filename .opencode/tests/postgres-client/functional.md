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

## Suite-level pass/fail

PASS = F-1..F-15 all green. Any unbounded external command; a destructive statement executed
without confirmation; a read-only connection executing a destructive statement; a single
action executing more than one statement; a plaintext credential sentinel in repo/logs/export;
an unbounded result grid with no default row limit or Load more; Mission Monitor blank while
live/stored rows exist = **FAIL**. UNVERIFIED rows (no reachable induction lever) are not
PASS — the verdict fails closed (G-033).
