# postgres-lifecycle — Regression

> "Must not change" baseline for the embedded-PostgreSQL lifecycle supervisor domain. Seeded at
> issue **#2974** (slice 1 of 6). These invariants MUST hold after the slice — any FAIL is a
> regression. Run on every testing phase that touches app startup, process supervision, the RTDB
> row pipeline, or the Mission Monitor rendering path.
>
> **Verification policy: live** — the app-boot + row-pipeline invariants are only observable on a
> running app; the Tester's Evidence MUST reference `telemetry_spans` (via functional F-15) for a
> live verdict. A static-only PASS is a FALSE PASS.

> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2974` / `-Action Down`. Never an
> unbounded run; never a bare `postgres`/`pg_ctl`. The named failure mode is the #2948 ~11 h
> `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types (`RowDelivery` / `RowDeliveryBatch`) are
  unchanged; emission remains ONLY via `EventBus.emit_row_delivery_batch` — no
  `app_handle.emit()` for row deliveries.
  **Edge / FAIL:** any row-pipeline hunk, a new event type/payload field, or a direct emit.

- [ ] **R-2 (Mission Monitor renders from the store — live):** after the change the app still
  boots, and Mission Monitor still lists live sessions and renders chat / tools / tokens from the
  RTDB rows; cross-check `telemetry_spans` at the same instant. This is functional F-15 mirrored
  as a standing invariant.
  **Edge / FAIL:** a blank/empty Mission Monitor while stored/live rows exist.

- [ ] **R-3 (OTLP + MCP binds unchanged):** OTLP gRPC 4317 / HTTP 4318 and the MCP bridge 9223
  still bind on 127.0.0.1; the PG server's ephemeral port never collisions with them.
  **Edge / FAIL:** a fixed PG port, or an OTLP/MCP bind failure after the change.

- [ ] **R-4 (llama-server supervision precedent untouched):** the shipped managed-child mechanism
  (`features/llm_server/process.rs` marker / sweep / tree-kill / spawn,
  `stop_llama_server_on_exit` in `features/llm_server/commands.rs`) and the `RunEvent::Exit` hook in
  `apps/tauri/src-tauri/src/lib.rs` still function; the PG supervisor is ADDITIVE to the same hook,
  not a replacement.
  **Edge / FAIL:** the llama-server marker/sweep or its exit-hook call broken.

- [ ] **R-5 (no cross-feature imports / architecture boundaries):** no cross-feature import
  introduced; process supervision belongs in the owning feature/module, not duplicated in
  `infrastructure/`; `tauri::async_runtime::spawn` is used, never `tokio::spawn`.
  **Edge / FAIL:** a `tokio::spawn` or a feature→feature import.

- [ ] **R-6 (AppStore KV contract unchanged):** the `settings(key,value)` KV shape is unchanged; the
  PG marker is a new KEY in the same KV, not a schema change to the store.
  **Edge / FAIL:** a `settings` table migration or a schema change.

- [ ] **R-7 (build gates):** `cargo check --locked` zero warnings AND
  `cargo clippy --locked -- -D warnings` AND `cargo test --locked` green (F-14); if UI is touched,
  `pnpm --filter @fredo/ui build` exits 0 with zero TS errors.
  **Edge / FAIL:** `cargo check` green but clippy red (check alone does NOT clear the clippy gate),
  or any warning.

- [ ] **R-8 (no unbounded run introduced):** no new code path introduces an unbounded/blocking wait;
  the bounded-stop + watchdog + fallback + sweep layers all remain (the #2948 failure mode stays
  mitigated).
  **Edge / FAIL:** any await without a finite bound.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-9:** inherit and run `.opencode/tests/mission-monitor/regression.md` — the row-pipeline /
  Mission Monitor surface this supervisor change must not disturb.
- [ ] **R-10:** inherit and run `.opencode/tests/llama-setup/regression.md` R-17/R-22 (chat contract
  + architecture boundaries) — the managed-server precedent surface.
- [ ] **R-11:** inherit and run `.opencode/tests/event-persistence/` and `.opencode/tests/realtime-data/`
  regression legs (when present) — the RTDB row-pipeline / feature-data surface.
- [ ] **R-12:** inherit `.opencode/tests/embedded-postgres-migration/regression.md` (R-1..R-7) — once
  the actual migration begins (later slices), those spike-only invariants become true runtime
  invariants and are deliberately re-scoped; slice 1 must keep the persistence path unchanged while
  PostgreSQL is disabled.

## Notes

- This suite is reusable across all six Postgres slices. Slice 1 delivers the lifecycle supervisor
  ONLY: no store migration, persistence unchanged while PostgreSQL is disabled.
