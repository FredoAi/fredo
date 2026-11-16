# pg-auth-recovery — Regression

> "Must not change" baseline for the embedded-PostgreSQL `AuthMismatch` recovery banner + the
> `WHILE Failed` log-flood back-off. Seeded at issue **#3067**. Run on every testing phase that
> touches the PG supervisor failure-kind surface, the app-shell host, or the storage-unavailable
> error emitters.

> **Verification policy: live** — the app-boot + row-pipeline invariants are only observable on a
> running app; the Tester's Evidence MUST reference a live receipt (`telemetry_spans` or a
> `tauri_webview_*` result). A static-only PASS is a FALSE PASS.

> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `dev-env.ps1 -Action Up|Down -Spec 3067 -EnvId spec3067 -EnvSlot 1 -RequireIsolation`. Never an
> unbounded run; never a bare `postgres`/`pg_ctl`. The named failure mode is the #2948 ~11 h
> `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (Settings → Database pane untouched):** `PostgresSettings.tsx` behaviour is unchanged —
  the `Reset database…` action, its `alertdialog` + ack checkbox, and the `DRIFT_TEXT` classification
  still render and work as before. The banner is ADDITIVE; the pane is not edited.
  **Edge / FAIL:** any diff hunk in `PostgresSettings.tsx`, or a changed reset flow in the pane.

- [ ] **R-2 (fail-closed preserved):** `engine_or_err` / `pg()` (`engine.rs:234-255`) still return the
  fail-closed `engine not ready` error, and the fail-closed contract is intact — only the *rate* of
  error emission changed (AC5). No insert attempt is skipped.
  **Edge / FAIL:** a changed `engine_or_err` message, or a dropped write attempt.

- [ ] **R-3 (no new IPC / no new event):** status is read through the EXISTING `pg_supervisor_status`
  command and reset through the EXISTING `pg_database_reset`; no new Tauri command, no new supervisor
  status event, no `app_handle.emit()`.
  **Edge / FAIL:** a new command/event, or a direct emit for row deliveries.

- [ ] **R-4 (secret handling unchanged):** `PgStatusView` / `PgConfigView` carry NO secret field; the
  banner consumes only `state`, `failureKind`, `error`; no password is rendered or logged.
  **Edge / FAIL:** a secret field on a status payload, or a password in the DOM/log.

- [ ] **R-5 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types are unchanged; emission remains ONLY via
  `EventBus.emit_row_delivery_batch`. Mission Monitor still renders live sessions/tools/tokens.
  **Edge / FAIL:** any row-pipeline hunk, a new event type/payload field, or a direct emit.

- [ ] **R-6 (back-off identity when the engine is ready):** with a `ready` cluster the per-site
  `ErrorBackoff` gates are transparent — unrelated errors are NOT suppressed, and a successful write
  resets the schedule (normal operation unaffected).
  **Edge / FAIL:** an unrelated error suppressed while ready, or the back-off never resetting.

- [ ] **R-7 (no auto self-heal):** the app NEVER invokes `pg_database_reset` on its own; recovery is
  always an explicit, confirmed user action.
  **Edge / FAIL:** any automatic reset on entering `Failed`.

- [ ] **R-8 (build gates):** `cargo check --locked` zero warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green; `pnpm --filter @fredo/ui build`
  exits 0 with zero TS errors.
  **Edge / FAIL:** `cargo check` green but clippy red, or any warning.

- [ ] **R-9 (no unbounded run introduced):** no new code path introduces an unbounded/blocking wait;
  the poll is a fixed-interval read with a finite teardown.
  **Edge / FAIL:** any await without a finite bound.

## Linked suites (overlapping surface — run alongside)

- [ ] **L-1:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` (R-1..R-8) — the
  supervisor lifecycle surface this change must not disturb.
- [ ] **L-2:** inherit and run `.opencode/tests/postgres-config/functional.md` F-3 (Reset database
  recovers a drifted credential) — the pre-existing drift/reset path the banner reuses.
- [ ] **L-3:** inherit and run `.opencode/tests/env-isolation/regression.md` — the round-isolation
  guard (shared-dir refusal; `Restart` forbidden for isolated envs).
- [ ] **L-4:** inherit and run `.opencode/tests/mission-monitor/regression.md` — the row-pipeline /
  Mission Monitor surface the back-off change must not disturb.

## Notes

- This suite is reusable across later PG supervisor slices. The banner reuses the existing status seam;
  the only backend behaviour change is the *rate* of error emission (AC5), never the write attempts.
