# postgres-config — Functional

Durable functional suite for the **embedded-PostgreSQL configuration editing** feature domain:
the Settings → **PostgreSQL** tab that changes the superuser password in place, invokes the warned
destructive Reset database, pins the port, sets log verbosity, and applies/restarts the managed
cluster. Seeded at issue **#3022**. Inherited by every later slice that edits managed-PG config.

> **Verification policy: LIVE** — every AC is provable only by observing a running cluster plus a
> live Settings apply/restart. The Tester's Evidence MUST reference `telemetry_spans` (functional
> F-12) — a static-only PASS is a FALSE PASS.

> **G-263 SAFETY (named failure mode): the #2948 ~11 h `pg.stop()` hang.** Every external-runtime
> start (the app dev instance AND the postmaster) MUST be bounded. The live app legs start/stop
> through `powershell -File .opencode/scripts/dev-env.ps1 -Action Up` / `-Action Down` — never a
> hand-rolled spawn, never a bare `postgres`/`pg_ctl`. An observed unbounded wait is a FAIL, not a
> skip.

> **Induction seams (G-275/G-300).** State dir under `.opencode/tmp/3022/`: `FREDO_PG_DATA_DIR`,
> `FREDO_PG_LOCK_DIR`, `FREDO_PG_INSTALL_DIR`. Drift: `FREDO_PG_PASSWORD_FILE` seeded stale, or a
> live `ALTER USER postgres PASSWORD …`. Port collision: pin `9223` (MCP) / `4318` (OTLP). Live
> receipt: a real agent session / companion generation — never `fredo emit` (G-256).

## Cases

- [ ] **F-1 (REQ-5/REQ-1 surface) — PostgreSQL tab reachable + pane renders.**
  Open Settings; confirm the **PostgreSQL** nav item exists and opens a pane with a write-only
  password field, a port control, a log-verbosity control, an **Apply** button, and a **Reset
  database** action.
  **Expected:** the nav item renders and the pane shows all controls; no console error.
  **FAIL** = the tab is absent or the pane is blank.

- [ ] **F-2 (REQ-1 / AC1, QA-1) — password change in place, no re-init, no data loss.**
  On a `ready` cluster record `pg_supervisor_status.dataDir`; write a canary row; open Settings →
  PostgreSQL; enter a new password; **Apply**. Connect with the new password; retry the old.
  **Expected:** inline success; `ready` with the SAME `dataDir` and a bound port; the NEW password
  authenticates; the OLD is rejected (`password authentication failed`); the canary row still reads
  back; no second `initdb`; the field re-renders empty/masked.
  **FAIL** = a re-init (data loss), the old password still works, or the new one does not.

- [ ] **F-3 (REQ-2 / AC2, QA-2) — Reset database recovers a drifted credential.**
  With keychain password P0 and the cluster `ready`, induce drift (seed `FREDO_PG_PASSWORD_FILE`
  stale, or `ALTER USER postgres PASSWORD '<other>'` leaving the keychain at P0), restart → readiness
  auth fails. Invoke **Reset database**, read the warning, confirm.
  **Expected:** a destructive warning dialog with data-loss text renders; after confirm the cluster
  re-initialises with P0, returns `ready`, and a connection with P0 succeeds; schema re-inits run and
  a live session's spans land in `telemetry_spans`.
  **FAIL** = no warning, no recovery, or the OpenCode profile destroyed.

- [ ] **F-4 (REQ-3 / AC3, QA-3a) — default port is OS-assigned.**
  Boot with no port pinned; read `pg_supervisor_status.port`; restart once.
  **Expected:** non-zero port on `127.0.0.1`, never 4317/4318/9223; the value differs across
  restarts.
  **FAIL** = a fixed/colliding port, or the app fails to bind OTLP/MCP.

- [ ] **F-5 (REQ-3 / AC3, QA-3b) — pin a fixed port and apply.**
  Pick a free high port (verify not listening); set it; **Apply**.
  **Expected:** restart succeeds; `pg_supervisor_status.port` == the pinned port; only
  `127.0.0.1:<pin>` listens; probe `ready`.
  **FAIL** = the pinned port is not bound, or another bind is disturbed.

- [ ] **F-6 (REQ-3 / AC3 negative, QA-3c) — pinned port in use → fail closed, prior config retained.**
  Pin a port already held by the running app (`9223` MCP or `4318` OTLP); **Apply**.
  **Expected:** restart FAILS CLOSED; an inline error names the port/bind failure; the pane does NOT
  report success; the prior working configuration is RETAINED (the next boot is `ready` on the
  prior/default ephemeral port); no data loss.
  **FAIL** = a false success, a hung apply, data loss, or a lost prior config.

- [ ] **F-7 (REQ-4 / AC4, QA-4) — log verbosity persists, takes effect, survives app restart.**
  Set a non-default verbosity; **Apply**; observe the effect; fully quit + relaunch; re-open Settings
  → PostgreSQL.
  **Expected:** the value persists; after the cluster restart the server runs with it (the named PG
  parameter is in effect via `postgresql.conf` / `SHOW` / log volume); after a FULL app restart the
  field shows it and the server still runs with it.
  **FAIL** = the value resets on restart, or has no effect.

- [ ] **F-8 (REQ-5 / AC5 security, QA-5a) — password is write-only, never displayed.**
  Save a password; reload the pane; inspect the field + any config-get payload.
  **Expected:** the input is masked (`type=password`) and the saved value is NOT in the DOM; no IPC
  command returns the cleartext; `pg_supervisor_status` / config-get omit the password field.
  **FAIL** = the secret is displayed or returned.

- [ ] **F-9 (REQ-5 / AC5 security negative, QA-5b) — sentinel never lands in app-data/logs/telemetry.**
  Set the password to `qa3022-sentinel-<uuid>`; **Apply**; scan app-data config files
  (`boot-config.json`, KV/config files), the PG `settings` table, `telemetry_logs` /
  `telemetry_spans` / `telemetry_metrics`, and `<data_dir>/log/postgres.log`.
  **Expected:** ZERO occurrences anywhere (the OS keychain excepted); the `ALTER USER … PASSWORD …`
  statement is redacted in any log/trace.
  **FAIL** = any occurrence of the sentinel.

- [ ] **F-10 (REQ-5 / AC5, QA-5c) — cluster is loopback-only.**
  Inspect the listening socket + `pg_hba.conf`.
  **Expected:** the PG port LISTENs on `127.0.0.1` only (never `0.0.0.0`); `pg_hba.conf` host entries
  are `127.0.0.1/32` (and/or `::1`) only.
  **FAIL** = a non-loopback bind.

- [ ] **F-11 (REQ-5 / AC5, QA-5d) — fresh install, zero configuration.**
  Boot with a clean data dir and no config set.
  **Expected:** the app auto-installs (acquisition + `initdb`, bounded) and auto-loads (`ready`) with
  NO user configuration; no DB setup prompt; the Settings → PostgreSQL pane opens on defaults; the
  store serves rows.
  **FAIL** = a configuration prompt, or a failed auto-load.

- [ ] **F-12 (REQ-6 / NFR, QA-6) — live telemetry receipt + Mission Monitor.**
  After any apply/Reset and a `ready` cluster, drive a live agent session (a Terminal agent session
  or an active companion generation) so OTLP spans ingest; open Mission Monitor; cross-check
  `telemetry_spans` at the same instant.
  **Expected:** Mission Monitor lists the live session and renders chat/tools/tokens from classified
  rows; `telemetry_spans` returns a NON-ZERO result for that session.
  **FAIL** = a static-only receipt, or `fredo emit` used as the lever.

- [ ] **F-13 (REQ-6 / NFR, QA-8) — pane busy/disabled during restart.**
  Click **Apply**; during the restart inspect the pane and double-click Apply.
  **Expected:** the pane shows a busy state and its controls are DISABLED; a second click does not
  queue a second restart; on completion the pane re-enables with inline success/failure.
  **FAIL** = double-apply queues two restarts, or controls stay enabled mid-restart.

## Non-functional

- [ ] **N-1 (build hygiene):** `cargo check --locked` + `cargo test --locked` +
  `cargo clippy --locked -- -D warnings`; if the UI is touched, `pnpm --filter @fredo/ui build`
  exits 0 with zero TS errors.
- [ ] **N-2 (accessibility):** the password field is labeled; the destructive Reset dialog is
  focus-trapped and Esc-cancellable; the busy state is announced.
- [ ] **N-3 (theme):** the pane uses semantic tokens / `tint()` only (no hardcoded hex), verified in
  BOTH light and dark themes.
- [ ] **N-4 (states):** defaults render when no config exists yet; an inline error renders on
  failure; no crash on `failed` state.
- [ ] **N-5 (bounds):** every apply/restart wait is finite (the #2948 failure mode stays mitigated);
  no unbounded wait on any leg.

## Suite-level pass/fail

PASS = F-1..F-13 green and N-1..N-5 hold, with F-12 carrying a `telemetry_spans` receipt. Any secret
occurrence, any data loss on a password change, any non-retained prior config on a collision failure,
any non-loopback bind, an unbounded wait, or a static-only receipt = **FAIL**.
