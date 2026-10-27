# db-client-builtin — Regression

The "must not change" baseline for the built-in-connection slice. Every spec touching the
`database-client` / `pg_supervisor` surface re-runs these.

> **Verification policy: LIVE** for the live rows; static pins noted where marked.

## Inherited suites (overlapping surface)

- `.opencode/tests/postgres-client/` — client create/list/edit/delete, read-only safety, credential
  secrecy, schema/query/export. **Run its `regression.md` + `functional.md`** for the ordinary
  (non-builtin) connection paths that must stay byte-identical.
- `.opencode/tests/postgres-connection-headroom/` — the 12 > 8 > 2 admission headroom. **Run it**
  to prove the built-in connection did not reduce the server/client headroom.
- `.opencode/tests/postgres-lifecycle/`, `postgres-config/`, `postgres-stores/` — supervisor
  lifecycle/port/config/store on the overlapping surface.

## Cases

- [ ] **R-1 (ordinary connections unchanged):** create/edit/delete an ORDINARY connection via
  `db_connection_save` / `db_connection_delete`; its `fredo.dbclient` per-connection keychain path is
  byte-identical; `builtin=false` on every ordinary row.
  **FAIL** = the ordinary create/edit/delete or credential path changed.
- [ ] **R-2 (read-only default unchanged):** a NEWLY created connection still defaults to
  `accessMode=readOnly` (`DEFAULT_ACCESS_MODE`, `connect.rs:75,481-487`).
  **FAIL** = the default changed.
- [ ] **R-3 (no new command):** the `db_*` / `pg_supervisor_status` command set is unchanged — no new
  Tauri command was added for the built-in.
  **FAIL** = a new command id in the surface.
- [ ] **R-4 (no cross-application import):** `applications/db_client` does NOT `use
  applications::pg_supervisor`; the endpoint/credential cross via
  `infrastructure/storage/embedded_pg`. **FAIL** = a cross-app import.
- [ ] **R-5 (store key unchanged):** `Fredo_dbclient_connections` is the store key; the persisted
  document is additive (`builtin` serde-defaulted) so an existing document still parses.
  **FAIL** = a renamed key or a document that fails to parse.
- [ ] **R-6 (supervisor port policy unchanged):** port policy, pinned-port collision handling, and
  config persistence are untouched; `port=0`/unset still means OS-assigned ephemeral.
  **FAIL** = a port-policy change.

## Server-side read-only hardening baseline (#3080)

The server-side layer is **additive**: the built-in's client-side `readOnlyBlocked` refusal
(F-9) is unchanged, and no wire/persisted shape changes.

- [ ] **R-7 (built-in client-side refusal unchanged):** the built-in connection still refuses
  every non-`read` statement with `readOnlyBlocked` **before** server contact (F-9); the built-in
  row stays `builtin=true` / `accessMode=readOnly` / `port=0` sentinel.
  **FAIL** = the refusal or the seeded row changed.
- [ ] **R-8 (no wire / document change):** `StatementClass` variants + serde names unchanged; the
  `Fredo_dbclient_connections.json` document parses as before (`builtin` serde-defaulted).
  **FAIL** = a document that fails to parse or a renamed variant.
- [ ] **R-9 (build gates):** `cargo check` zero warnings (no `#[allow]`); `cargo nextest run`
  green. **FAIL** = any warning or failing test.
