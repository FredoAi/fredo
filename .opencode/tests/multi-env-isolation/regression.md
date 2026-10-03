# multi-env-isolation — Regression

> "Must not change" baseline for the multiple-isolated-environments feature (#2944). These
> invariants MUST hold after the change — any FAIL is a regression. Run on every testing phase
> that touches app startup, process supervision, ports/sockets, the dev-env lever, or the
> Mission Monitor rendering path.
>
> **Verification policy: live** — the app-boot + row-pipeline invariants are only observable on a
> running app; the Tester's Evidence MUST carry live receipts (functional F-6 / `telemetry_spans`)
> for a live verdict. A static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** every live leg is time-bounded and torn down via the `dev-env.ps1` lever.
> Never an unbounded run; never a bare `postgres`/`pg_ctl`.

## Must NOT change (regression invariants)

- [ ] **R-1 (single-instance dev-env behavior preserved — out-of-scope guard):** the existing
  single-environment `dev-env.ps1 -Action Up|Down|Status|Restart|Logs` path still works with no
  `-EnvId` and default ports (5174 Vite / 9223 MCP); singleton behavior within one issue/spec
  stays. **Edge / FAIL:** the default single-instance path breaks or now requires an env ID.

- [ ] **R-2 (OTLP + MCP binds unchanged for a single env):** OTLP gRPC 4317 / HTTP 4318 and the
  MCP bridge 9223 still bind on 127.0.0.1 for the default env; no fixed-port leak; a multi-env run
  does not steal a default-env port. **Edge / FAIL:** an OTLP/MCP bind failure, or a default-env
  port taken by a second env.

- [ ] **R-3 (no global image-name kill introduced):** teardown/Clean never issues a global
  image-name kill (`taskkill /IM fredo.exe|postgres.exe|node.exe`); it acts only on the target
  env's own process manifest. **Edge / FAIL:** any `-IM` kill introduced by the isolation work.

- [ ] **R-4 (Mission Monitor renders from the store — live):** after the change the app still
  boots, and Mission Monitor still lists live sessions and renders chat / tools / tokens from the
  RTDB rows in a single default env AND in each isolated env; cross-check the env's DB at the same
  instant. This is functional F-6 mirrored as a standing invariant. **Edge / FAIL:** a
  blank/empty Mission Monitor while stored/live rows exist, or a cross-env row appearing.

- [ ] **R-5 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types (`RowDelivery` / `RowDeliveryBatch`) are
  unchanged; emission remains ONLY via `EventBus.emit_row_delivery_batch` — no
  `app_handle.emit()` for row deliveries. **Edge / FAIL:** any row-pipeline hunk or a direct emit.

- [ ] **R-6 (llama-server supervision precedent untouched):** the shipped managed-child mechanism
  (`features/llm_server/process.rs` marker / sweep / tree-kill / spawn,
  `stop_llama_server_on_exit`) and the `RunEvent::Exit` hook still function; per-env supervision is
  ADDITIVE, not a replacement. **Edge / FAIL:** the llama-server marker/sweep or its exit-hook call
  broken.

- [ ] **R-7 (no cross-feature imports / architecture boundaries):** no cross-feature import
  introduced; process/env state belongs in the owning feature/module, not in `infrastructure/`;
  `tauri::async_runtime::spawn` is used, never `tokio::spawn`. **Edge / FAIL:** a `tokio::spawn` or
  a feature→feature import.

- [ ] **R-8 (build gates):** `cargo check` zero warnings, `pnpm --filter @fredo/ui build` exits 0
  with zero TS errors, and `.opencode/scripts/test-scripts.ps1` all green. **Edge / FAIL:** any red
  gate.

- [ ] **R-9 (no unbounded run introduced):** no new code path introduces an unbounded/blocking
  wait; every start/stop/teardown has a finite bound + hard-kill fallback. **Edge / FAIL:** any
  await without a finite bound.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-10:** inherit and run `.opencode/tests/mission-monitor/regression.md` — the row-pipeline /
  Mission Monitor surface this feature must not disturb.
- [ ] **R-11:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — process
  supervision / PID-marker / no-orphan invariants the per-env manifests must not regress.
- [ ] **R-12:** inherit and run `.opencode/tests/launcher/regression.md` (when present) — the
  `fredo` CLI path / launcher surface each env must keep reachable.

## Notes

- Out of scope (do NOT assert): packaged-install / end-user profile isolation; singleton behavior
  within one issue/spec stays; no product feature work.
- This suite is reusable by any later spec that touches dev-env instance management or port/socket
  allocation.
