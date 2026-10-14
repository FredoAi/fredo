# Functional — fredo-health-led

Durable suite for the whole-system health LED (feature #3052). One `- [ ]` case per requirement, each with an observable expected outcome and its required test data. Verification policy: **live** (UI rendering from four live backend sources); at least one leg must cite a `telemetry_spans` live-query result. Evidence frames are referenced by name without image extensions (G-104).

## Cases

- [ ] **F-1 (covers R-1 / AC1) — aggregate is whole-system, not telemetry-only.**
  - Data: live dev app; telemetry connected; Postgres `ready`; companion installed + healthy.
  - Steps: read `[data-testid="desktop-status-led-overall"]` text + `data-health-state`; then fail ONE non-telemetry subsystem (F-4 lever) with telemetry still connected; re-read.
  - Expected: baseline overall `data-health-state="healthy"`; after, overall is NOT `healthy` while `useConnectionStatus().isConnected === true`. Proves the aggregate folds all enabled subsystems, not the stream alone.

- [ ] **F-2 (covers R-2 / AC2) — tooltip enumerates four lines in fixed order + one overall line.**
  - Steps: hover `desktop-status-led`; read the `desktop-status-led-tooltip` subtree.
  - Expected: exactly ONE `desktop-status-led-overall` plus the four lines in DOM order `health-line-telemetry` → `health-line-llamaServer` → `health-line-companionModel` → `health-line-postgres`, each with `data-health-state` and non-empty state text; the overall line also carries `data-health-state`.

- [ ] **F-3 (covers R-3 / AC3) — mandatory telemetry down ⇒ not healthy.**
  - Data: Postgres `ready`, companion healthy; stop the agent/opencode process feeding the stream (`dev-environment` stop).
  - Expected: `health-line-telemetry` and overall `data-health-state="down"`; the other three lines unchanged.

- [ ] **F-4 (covers R-3 / AC3) — mandatory Postgres down ⇒ not healthy (issue scenario).**
  - Data: `FREDO_PG_FORCE_START_FAIL=1` (see lever list below).
  - Expected: `health-line-postgres` and overall `data-health-state="down"`; the other lines stay `healthy`.

- [ ] **F-4b (static/unit pin — NON-AC) — `pg_supervisor_status` `disabled` ⇒ `down`.**
  - Data: ST-1 unit test `apps/ui/src/shared/hooks/__tests__/fredoHealth.test.ts`.
  - Expected: `deriveSubsystemLines` maps `state: 'disabled'` → `postgres` = `down`; `aggregateFredoHealth` → overall `down`. (`disabled` is NOT live-reachable — PostgreSQL is unconditional, so the mapping is pinned statically.)

- [ ] **F-5 (covers R-4 / AC4) — never-installed companion is neutral.**
  - Data: fresh env, no companion configured.
  - Expected: `health-line-llamaServer` and `health-line-companionModel` both `data-health-state="notSetUp"` with text "Not set up"; overall stays `healthy` while both mandatory subsystems are healthy.

- [ ] **F-6 (covers R-4 / AC4) — installed-but-down companion degrades [the ONLY path to `degraded`].**
  - Data: companion installed + its three model files complete + managed server healthy; then kill the managed `llama-server` process (`taskkill /IM llama-server.exe /F`).
  - Expected: `health-line-llamaServer` `data-health-state="down"`; overall exactly `degraded` (optional subsystem down, both mandatory healthy).
  - Second leg: delete one of `model`/`vision`/`mtp` from the companion models dir while installed → `health-line-companionModel` `down`, overall `degraded`.

- [ ] **F-7 (covers R-5 / AC5) — state by text + accessible label; LED keyboard-reachable.**
  - Steps: Tab to the trigger; read the composed `aria-label` and the tooltip text.
  - Expected: trigger keeps `role="status"`, `aria-live="polite"`, `aria-atomic="true"`, `tabIndex={0}`; composed `aria-label` = `Fredo health: <Overall> — Agent telemetry: <s>; Llama server: <s>; Companion model: <s>; Postgres: <s>`; the SAME states render as tooltip text. No state is conveyed by colour alone.

- [ ] **F-8 (covers R-6) — bounded refresh, no IPC per render.**
  - Data: IPC monitor (`tauri_ipc_monitor`); ≥2 poll intervals; fire a `llama-server-status` event.
  - Expected: ≤1 probe-set per `HEALTH_POLL_INTERVAL_MS` (15 000 ms); ≤3 read-only IPCs per tick; telemetry NOT polled; zero IPC on a re-render; the event triggers an immediate llama refresh; a stale/out-of-order response is dropped by the seq guard.

- [ ] **F-9 (covers R-7) — first-probe settle → neutral `unknown` → "Checking".**
  - Data: cold start / throttled backend so a probe is in flight at mount.
  - Expected: the unresolved line reads `data-health-state="unknown"` + text "Checking"; `unknown` never degrades the aggregate; each line reconciles within ONE poll interval.

## Induction levers (all in-repo; inert when unset — G-275 / G-300)

- **Postgres `failed` (F-1/F-4):** `FREDO_PG_FORCE_START_FAIL=1` (`pg_supervisor/mod.rs:183`) → `PgRuntime::start` fails closed without spawning → the boot leg publishes `Failed` (`state.rs:476-479`). Alternative: `FREDO_PG_DATA_DIR` → a stale-locked dir under `.opencode/tmp/3052/pgdata` with no live descriptor → `failed_only` (`state.rs:427-438`).
- **Postgres `disabled` (F-4b):** NOT live-reachable (PostgreSQL is unconditional — `state.rs:395-398`; the no-state fallback is `state.rs:1465-1477`) → static pin, non-AC.
- **Telemetry stream down (F-3):** stop the agent/opencode process feeding the stream (`dev-environment` stop) so the Tauri connection listener sets `isConnected=false`; restart to recover.
- **Companion never installed (F-5):** a fresh env with no companion config.
- **Companion installed-but-down (F-6):** install the companion + its three model files via Companion settings, start the managed server healthy, then kill the managed `llama-server` process (Task Manager / `taskkill /IM llama-server.exe /F`); OR point the companion config (tester-written under `.opencode/tmp/3052/companion/`) at a missing `.gguf` → `failed`.

## Live evidence anchor

- At least one case (F-1) must carry a `telemetry_spans` live-query result showing the app ingested OTLP spans during the drive (embedded PostgreSQL `fredo` DB; disclose the port).
