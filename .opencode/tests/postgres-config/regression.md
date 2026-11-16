# postgres-config — Regression

> "Must not change" baseline for the embedded-PostgreSQL configuration-editing domain. Seeded at
> issue **#3022**. These invariants MUST hold after the slice — any FAIL is a regression. Run on
> every testing phase that touches managed-PG config, the Settings surface, or the RTDB row pipeline.
>
> **Verification policy: live** — the app-boot + row-pipeline invariants are only observable on a
> running app; the Tester's Evidence MUST reference `telemetry_spans` (via functional F-12). A
> static-only PASS is a FALSE PASS.

> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up` / `-Action Down`. Never an unbounded
> run; never a bare `postgres`/`pg_ctl`.

## Must NOT change (regression invariants)

- [ ] **R-1 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types are unchanged; emission remains ONLY via
  `EventBus.emit_row_delivery_batch` — no `app_handle.emit()` for row deliveries.
  **Edge / FAIL:** any row-pipeline hunk, a new event type/payload field, or a direct emit.

- [ ] **R-2 (Mission Monitor renders from the store — live):** after the change the app still boots
  and Mission Monitor still lists live sessions and renders chat / tools / tokens from the RTDB rows;
  cross-check `telemetry_spans` at the same instant (functional F-12 mirrored).
  **Edge / FAIL:** a blank/empty Mission Monitor while stored/live rows exist.

- [ ] **R-3 (OTLP + MCP binds unchanged):** OTLP gRPC 4317 / HTTP 4318 and the MCP bridge 9223 still
  bind on `127.0.0.1`; the PG server's port (ephemeral or pinned) never collides with them.
  **Edge / FAIL:** an OTLP/MCP bind failure after a config apply.

- [ ] **R-4 (keychain remains the ONLY secret store):** the loopback password is read/written only
  through the `PgCredentialStore` seam / OS keychain (`credentials.rs`); it never enters the
  synchronous settings cache, the PG `settings` table, `boot-config.json`, tracing, or a log.
  **Edge / FAIL:** the password appears in any config file, KV row, or telemetry row.

- [ ] **R-5 (lifecycle + teardown untouched):** `run_start()` orchestration, the bounded start/stop,
  the watchdog hard-kill fallback, the exit hook, and the orphan sweep keep their behaviour
  (`runtime.rs` / `state.rs`); a config apply must reuse this bounded path — never a new unbounded
  restart.
  **Edge / FAIL:** a new unbounded await, or the exit-hook teardown broken.

- [ ] **R-6 (no cross-feature imports / boundaries):** no cross-feature import; config state lives in
  the owning application module, not `infrastructure/`; `tauri::async_runtime::spawn` is used, never
  `tokio::spawn`.
  **Edge / FAIL:** a `tokio::spawn` or a feature→feature import.

- [ ] **R-7 (settings shell intact):** the existing settings sections (Companion, Appearance, Fredo
  Setup, Telemetry, Apps, Ingest, Layout) still render and save; the new PostgreSQL tab is ADDITIVE
  and does not disturb `SettingsSurface.tsx` section composition or the unified Save footer.
  **Edge / FAIL:** a missing/broken existing settings section.

- [ ] **R-8 (build gates):** `cargo check --locked` zero warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green; if UI is touched,
  `pnpm --filter @fredo/ui build` exits 0 with zero TS errors (functional N-1).
  **Edge / FAIL:** `cargo check` green but clippy/UI-build red.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-9:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the bounded
  lifecycle / teardown surface a config apply reuses.
- [ ] **R-10:** inherit and run `.opencode/tests/settings/regression.md` — the settings-surface
  baseline the new tab is added to.
- [ ] **R-11:** inherit and run `.opencode/tests/postgres-stores/regression.md` (when present) — the
  store/persistence surface the cluster serves.
- [ ] **R-12:** inherit and run `.opencode/tests/mission-monitor/regression.md` — the row-pipeline /
  Mission Monitor rendering surface.
