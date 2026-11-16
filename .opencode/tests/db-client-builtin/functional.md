# db-client-builtin — Functional

Durable functional suite for the **built-in "Fredo" PostgreSQL connection** feature domain: the
`database-client` app seeds ONE read-only connection (`id="builtin-fredo"`, `name="Fredo"`) to
Fredo's own embedded cluster on a fresh profile, with zero typed credentials, that survives a
cluster restart on a NEW ephemeral port without a persisted port or secret. Seeded at issue
**#3029**. Inherits `.opencode/tests/postgres-client/` (client surface, read-only safety,
credential secrecy) and `.opencode/tests/postgres-connection-headroom/` (the 12 > 8 > 2 admission
headroom this feature connects on).

> **Verification policy: LIVE** — every case observes a running app + embedded cluster: a
> fresh-profile seed rendered in the UI, a live connect + query, and a live restart that binds a
> NEW ephemeral port. The testing exit gate and audit fail-closed unless the Tester's Evidence
> references a live receipt — a `telemetry_spans` query (F-12). A static/unit-only PASS is a FALSE
> PASS.

> **G-263 SAFETY:** never run an unbounded binary. The test PG instance is the app's embedded PG,
> started/stopped ONLY through `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Restart|Down -Spec 3029`
> (`Restart` = Down then Up, `dev-env.ps1:1645-1688`). Every managed-`psql` command is time-bounded
> (≤60 s); connect ≤10 s.

> **G-307/G-284 READ LEVER + DISCLOSED SUBSTITUTION.** Re-resolve the port from
> `pg_supervisor_status` (never guess `0`) and the loopback password from the OS keychain
> (`fredo.postgres` / `loopback:password`) or `FREDO_PG_PASSWORD_FILE`; the sanctioned PG read is
> the managed `psql` via `.opencode/scripts/run-exitcode.ps1` (database `postgres`). Because the
> app pool can legitimately hold every server slot, when an external `psql` is refused
> `too many clients`, fall back to the app-pool-backed read for the same-instant number and
> DISCLOSE the substitution (precedent `postgres-connection-headroom/functional.md:15-23`).

> **Fresh-profile emulation.** A fresh profile is simulated by pointing `FREDO_DBCLIENT_STATE_DIR`
> at an EMPTY dir (`.opencode/tmp/3029/fresh-profile/`, no `Fredo_dbclient_connections.json`) — the
> seed keys solely on the store document's ABSENCE (`db_client/connect.rs:290-294`). The seam must
> be forwarded on EVERY launch, including a `Restart`.

## Cases

- [ ] **F-1 (EARS-1 / AC1) — fresh-profile seed, zero setup.**
  Boot with `FREDO_DBCLIENT_STATE_DIR=.opencode/tmp/3029/fresh-profile`; open the PostgreSQL app;
  call `db_connection_list`.
  **Expected:** exactly one row `id="builtin-fredo"`, `name="Fredo"`, `builtin=true`, with zero
  host/port/user/password typed by the user; a second `db_connection_list` returns the SAME single
  row (idempotent, no duplicate).
  **Edge:** dir absent vs present-but-empty. **FAIL** = zero rows, >1 row, or a duplicate.

- [ ] **F-2 (EARS-1 / AC1) — the built-in row renders.**
  Inspect `db-connection-row-builtin-fredo`: `db-connection-name` = "Fredo";
  `db-connection-builtin-badge` visible; `db-connection-target` resting text = `postgres@127.0.0.1/fredo`.
  **Expected:** the badge renders from theming tokens; NO `:0` appears in the target (the port
  sentinel is never surfaced) — asserted on the element's RESTING text (G-170).
  **Edge:** badge absent on an ordinary row. **FAIL** = badge missing, or `:0` visible.

- [ ] **F-3 (EARS-1 / AC1) — ordinary affordances.**
  The builtin row exposes the same `db-connection-edit-builtin-fredo` and
  `db-connection-delete-builtin-fredo` controls as any row; selecting/connecting uses the existing flow.
  **Expected:** edit + delete present and functional; no special-casing, no wizard.
  **FAIL** = a missing control or a special path.

- [ ] **F-4 (EARS-2 / AC1) — edit ⇒ ordinary.**
  Open edit on the builtin row, change the name, save.
  **Expected:** the persisted row has `builtin=false`; `db_connection_list` reflects the edit;
  endpoint re-resolution stops (ordinary path). The edit must NOT be blocked by the prefilled
  `port=0` (`validateConnectionFields`, `ConnectionForm.tsx:69-74`).
  **FAIL** = the form refuses the save, or the row stays `builtin=true`.

- [ ] **F-5 (EARS-2 / AC1) — delete is permanent; no re-seed.**
  Delete the builtin row; re-list; restart the app; re-list again.
  **Expected:** the row is absent; all four of its stores are removed; NOT re-seeded (the store
  document exists). A truly-fresh profile (F-1 dir) DOES re-seed.
  **Edge:** a partially-written store document still counts as "exists".
  **FAIL** = a deleted builtin reappears on the existing profile. *(G-275/G-300: the four stores
  must be named by the Architect — see the plan's Discussion.)*

- [ ] **F-6 (EARS-3 / AC2) — live connect + query.**
  With `pg_supervisor_status` Ready/Attached, `db_connect` the builtin row and run `SELECT 1`.
  **Expected:** connect succeeds ≤10 s with NO credential prompt; `SELECT 1` → `1`; host/port/user/
  database resolved from the LIVE supervisor at connect time.
  **Edge:** no `FATAL: sorry, too many clients already`; reconnect after an explicit disconnect.
  **FAIL** = prompt, refusal, hang, or panic.

- [ ] **F-7 (EARS-3 / AC2, #3028 headroom) — a second client still connects.**
  With the app pool holding its cap, open a further client connection.
  **Expected:** the second client connects (headroom 12 > 8 > 2 preserved; `MAX_OPEN_CONNECTIONS` = 2).
  **Edge:** app-pool fallback + disclosure if the external `psql` is refused.
  **FAIL** = a refusal while the app runs.

- [ ] **F-8 (EARS-4 / AC2 negative) — not-ready ⇒ typed error, no prompt.**
  Set `FREDO_PG_FORCE_START_FAIL=1` (`pg_supervisor/mod.rs:183`) and attempt `db_connect` of the
  builtin row.
  **Expected:** a typed `unreachable` (provider absent ⇒ `config`) within the 10 s bound; NO
  host/port/user/password prompt; no hang/panic.
  **Edge:** `Starting`/`Failed`/`Disabled`; ordinary connections unaffected.
  **FAIL** = a credential prompt, an untyped error, a hang, or a panic.

- [ ] **F-9 (EARS-5 / AC3) — read-only refusal.**
  On the builtin connection submit `CREATE TABLE qa_3029(x int)`, `INSERT`, `UPDATE`, `DELETE`, `DROP`.
  **Expected:** every non-`read` statement refused with `readOnlyBlocked` BEFORE any server contact;
  a managed-`psql` read confirms no side effect.
  **Edge:** mode resolved from the store (`query.rs:253-269`); the badge shows `Read-only`.
  **FAIL** = any statement executes.

- [ ] **F-10 (EARS-6 / AC4) — restart, NEW ephemeral port, no edit.**
  Note `port` from `pg_supervisor_status`; `dev-env -Action Restart -Spec 3029`; re-read the port;
  `db_connect` again with NO edit.
  **Expected:** the new port is DIFFERENT; connect succeeds with no user edit; the persisted builtin
  `port` stays the `0` sentinel.
  **Edge:** a pinned-port config makes the new-port condition unreachable — confirm the config port
  is unset/`0` first and DISCLOSE otherwise. **FAIL** = same port, any user edit, or a numbered port persisted.

- [ ] **F-11 (EARS-7 / AC5) — no persisted secret, no stale port.**
  After a successful connect read `Fredo_dbclient_connections.json`, AppStore KV, app console logs,
  `telemetry_logs`, and `telemetry_spans`.
  **Expected:** no `password`/`secret` key and no sentinel value in any surface; `DbConnectionView`
  carries only `has_password`; builtin `port == 0`.
  **Edge:** sentinel supplied via `FREDO_PG_PASSWORD_FILE`.
  **FAIL** = the sentinel/key found, or a numbered port persisted.

- [ ] **F-12 (NFR-1, LIVE receipt) — `telemetry_spans` round start + after.**
  Query `telemetry_spans` for a fresh `e2e-3029-*` session BEFORE the connection work and AGAIN
  after; drive a live OTLP-ingested agent action (never `fredo emit`, G-256); open Mission Monitor
  while the builtin connection is connected.
  **Expected:** the `telemetry_spans` result is NON-ZERO at both reads with the source disclosed;
  Mission Monitor renders the live session while the builtin connection is connected.
  **FAIL** = a static-only receipt, or an undisclosed substitution.

## Server-side read-only on the built-in connection (#3080)

Slice on top of #3029. The built-in **"Fredo"** connection is `ReadOnly` and targets the embedded
cluster as the **`postgres` superuser** — the exact superuser-on-a-"read-only"-connection case
`research/34-security-audit-2026-10-22.md` Finding #5 names. This makes it the **live AC1/AC2 lever**: PostgreSQL itself
now enforces read-only for it (`SET default_transaction_read_only = on` per physical connection
via `PgPoolOptions::after_connect`, `connect.rs`). F-9 (client-side refusal) is unchanged and is
now the *first* of two layers.

> **Live receipt form (G-256):** this change emits **no OTLP spans**, so its live receipt is a
> **live webview DOM/screenshot** (`tauri_webview_screenshot` + `tauri_webview_dom_snapshot`), not
> `telemetry_spans`. Never fabricate a span receipt via `fredo emit`.

> **G-263 SAFETY:** bounded legs; `.opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3080`;
> managed-`psql` ≤60 s. The reconnect lever is a bounded managed-`psql`
> `SELECT pg_terminate_backend(<app backend pid>)`.

- [ ] **F-13 (EARS-5b / AC1) — the built-in connection is server-side read-only.**
  Connect the built-in "Fredo" row; run `SHOW default_transaction_read_only;` (classifies `Read`).
  **Expected:** the grid shows exactly **`on`**; live DOM + screenshot captured.
  **Edge:** a readWrite connection (via the `FREDO_DBCLIENT_STATE_DIR` seam) shows `off`.
  **FAIL** = anything other than `on`.

- [ ] **F-14 (EARS-5b / AC1, BINDING) — the server rejects a `Read`-classified volatile write.**
  On the built-in connection run `SELECT * FROM chat_rows LIMIT 1 FOR UPDATE;`; secondary
  `SELECT nextval('qa_3080_seq');`.
  **Expected:** a typed `query` error carrying SQLSTATE **`25006`**; no side effect (managed-`psql`
  read). **Edge:** empty `chat_rows`; `FOR SHARE`. **FAIL** = the statement executes.
  *(AC1's named example list is illustrative — see `postgres-client F-18` for the recorded
  outcomes of `pg_terminate_backend`/`set_config`/`lo_import`/`nextval`.)*

- [ ] **F-15 (EARS-5b / AC2) — the server-side read-only survives a reconnect.**
  Verify `on`; force the physical connection to drop (bounded managed-`psql`
  `pg_terminate_backend(<app backend pid>)`); re-query.
  **Expected:** the replacement connection still reports `on` and still rejects F-14's write.
  **Edge:** cannot force a drop → key to hook-at-build + `pg_stat_activity` and DISCLOSE.
  **FAIL** = the replacement reports `off`, or a write executes.

## Non-functional

- [ ] **N-1 (loopback-only):** the seed persists `host="127.0.0.1"` and connect resolves the same;
  no `0.0.0.0`; the port never collides with 4317/4318/9223.
- [ ] **N-2 (no plaintext secret):** a sentinel scan across the connection store JSON, AppStore KV
  (`Fredo_dbclient_connections`), app console logs, `telemetry_logs`, and `telemetry_spans` finds no
  password/secret; `DbConnectionView` carries only `has_password`.
- [ ] **N-3 (theming tokens):** `db-connection-builtin-badge` styles use only
  `bg.*`/`fg.*`/`status.*`/`border.*` tokens (no hex/rgba); the theming application can restyle it.
- [ ] **N-4 (bounded external runtime, G-263):** `dev-env` Up/Down/Restart only; every
  managed-`psql` ≤60 s; no unbounded wait.
- [ ] **N-5 (build hygiene):** zero-warning `cargo check` and `pnpm --filter @fredo/ui build`.

## Suite-level pass/fail

PASS = F-1..F-7 and F-9..F-12 all green, F-8 green (or a named blocker), every NFR check holds, and
F-12 carries a `telemetry_spans` receipt. Any duplicate/re-seed of the built-in; a connect that
prompts for credentials; a persisted secret or numbered port; a write executed on the read-only
built-in; or a static-only receipt = **FAIL**. UNVERIFIED rows (no reachable lever) are not PASS —
the verdict fails closed (G-033).

## Round 1 results (2026-10-13, `spec/3029 @ ae6b73b`)

Live run on the isolated env `spec3029` (in-repo cluster, `FREDO_DBCLIENT_STATE_DIR` fresh-profile
seam + a known-password `FREDO_PG_PASSWORD_FILE`). **F-1..F-11 PASS:** fresh-profile seed exactly
one `builtin=true` row (idempotent); badge + `postgres@127.0.0.1/fredo` (no `:0`); edit ⇒
`builtin=false` (port prefilled from the live supervisor, Save not blocked); delete permanent
(four stores, no re-seed after a full app restart); live connect + `SELECT 1`; headroom
(`clients=10 ≤ max_connections=12`); `FREDO_PG_FORCE_START_FAIL=1` ⇒ typed `unreachable`, no prompt;
every write refused `readOnlyBlocked` with no side effect; restart bound a NEW ephemeral port
(60508 → 61142) and reconnected with no edit while the persisted `port` stayed `0`; no sentinel /
secret / numbered port in any scanned surface. **F-12 receipt PASS via a disclosed real-channel
substitution (G-256):** the Terminal opencode session emitted **0** spans (plugin emission —
environment blocker), so an OTLP/HTTP trace was posted to the app's own receiver (`:16083`) →
`telemetry_spans = 1` at both reads; Mission-Monitor-renders-the-live-session was not demonstrated
(named blocker). Full receipts in the feature issue's `## Tests Runs (round 1)` comment.
