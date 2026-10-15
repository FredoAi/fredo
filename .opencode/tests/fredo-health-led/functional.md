# Functional — fredo-health-led

Durable suite for the whole-system health LED (feature #3052). One `- [ ]` case per requirement, each with an observable expected outcome and its required test data. Verification policy: **live** (UI rendering from four live backend sources); at least one leg must cite a `telemetry_spans` live-query result. Evidence frames are referenced by name without image extensions (G-104).

## Cases

- [x] **F-1 (covers R-1 / AC1) — aggregate is whole-system, not telemetry-only.**
  - Data: live dev app; telemetry connected; Postgres `ready`; companion installed + healthy.
  - Steps: read `[data-testid="desktop-status-led-overall"]` text + `data-health-state`; then fail ONE non-telemetry subsystem (F-4 lever) with telemetry still connected; re-read.
  - Expected: baseline overall `data-health-state="healthy"`; after, overall is NOT `healthy` while `useConnectionStatus().isConnected === true`. Proves the aggregate folds all enabled subsystems, not the stream alone.

- [x] **F-2 (covers R-2 / AC2) — tooltip enumerates four lines in fixed order + one overall line.**
  - Steps: hover `desktop-status-led`; read the `desktop-status-led-tooltip` subtree.
  - Expected: exactly ONE `desktop-status-led-overall` plus the four lines in DOM order `health-line-telemetry` → `health-line-llamaServer` → `health-line-companionModel` → `health-line-postgres`, each with `data-health-state` and non-empty state text; the overall line also carries `data-health-state`.

- [x] **F-3 (covers R-3 / AC3) — mandatory telemetry down ⇒ not healthy.**
  - Data: Postgres `ready`, companion healthy; stop the agent/opencode process feeding the stream (`dev-environment` stop).
  - Expected: `health-line-telemetry` and overall `data-health-state="down"`; the other three lines unchanged.

- [x] **F-4 (covers R-3 / AC3) — mandatory Postgres down ⇒ not healthy (issue scenario).**
  - Data: `FREDO_PG_FORCE_START_FAIL=1` (see lever list below).
  - Expected: `health-line-postgres` and overall `data-health-state="down"`; the other lines stay `healthy`.

- [x] **F-4b (static/unit pin — NON-AC) — `pg_supervisor_status` `disabled` ⇒ `down`.**
  - Data: ST-1 unit test `apps/ui/src/shared/hooks/__tests__/fredoHealth.test.ts`.
  - Expected: `deriveSubsystemLines` maps `state: 'disabled'` → `postgres` = `down`; `aggregateFredoHealth` → overall `down`. (`disabled` is NOT live-reachable — PostgreSQL is unconditional, so the mapping is pinned statically.)

- [x] **F-5 (covers R-4 / AC4) — never-installed companion is neutral.**
  - Data: fresh env, no companion configured.
  - Expected: `health-line-llamaServer` and `health-line-companionModel` both `data-health-state="notSetUp"` with text "Not set up"; overall stays `healthy` while both mandatory subsystems are healthy.

- [x] **F-6 (covers R-4 / AC4) — installed-but-down companion degrades [the ONLY path to `degraded`].**
  - Data: companion installed + its three model files complete + managed server healthy; then kill the managed `llama-server` process (`taskkill /IM llama-server.exe /F`).
  - Expected: `health-line-llamaServer` `data-health-state="down"`; overall exactly `degraded` (optional subsystem down, both mandatory healthy).
  - Second leg: delete one of `model`/`vision`/`mtp` from the companion models dir while installed → `health-line-companionModel` `down`, overall `degraded`.

- [x] **F-7 (covers R-5 / AC5) — state by text + accessible label; LED keyboard-reachable.**
  - Steps: Tab to the trigger; read the composed `aria-label` and the tooltip text.
  - Expected: trigger keeps `role="status"`, `aria-live="polite"`, `aria-atomic="true"`, `tabIndex={0}`; composed `aria-label` = `Fredo health: <Overall> — Agent telemetry: <s>; Llama server: <s>; Companion model: <s>; Postgres: <s>`; the SAME states render as tooltip text. No state is conveyed by colour alone.

- [x] **F-8 (covers R-6) — bounded refresh, no IPC per render.**
  - Data: IPC monitor (`tauri_ipc_monitor`); ≥2 poll intervals; fire a `llama-server-status` event.
  - Expected: ≤1 probe-set per `HEALTH_POLL_INTERVAL_MS` (15 000 ms); ≤3 read-only IPCs per tick; telemetry NOT polled; zero IPC on a re-render; the event triggers an immediate llama refresh; a stale/out-of-order response is dropped by the seq guard.

- [x] **F-9 (covers R-7) — first-probe settle → neutral `unknown` → "Checking".**
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

## Round-2 induction seams (Spec #3052 round 2, `c5a7602`; all inert when unset — G-275)

- **FS-1 — forced telemetry down (F-3):** set `window.__FREDO_HEALTH_FORCE_TELEMETRY_DOWN__ = true`, or `sessionStorage['fredoHealthForceTelemetryDown'] = '1'`, or launch the Vite dev server with `VITE_FREDO_HEALTH_FORCE_TELEMETRY_DOWN=1`. Read on each bounded tick ⇒ `telemetryConnected:false` ⇒ telemetry `down` ⇒ overall `down`. Clear the key to restore `healthy` (paired control).
- **FS-2 — forced companion-not-installed (F-5):** launch the app with `-EnvVar "FREDO_COMPANION_FORCE_NOT_INSTALLED=1"` (probe-only) ⇒ both companion prerequisites `Missing` ⇒ both companion lines `notSetUp`. Always pair with an unset control boot.
- **FS-4 — probe-set counter (F-8):** set `window.__FREDO_HEALTH_INSTRUMENT_PROBES__ = true` (or `sessionStorage['fredoHealthInstrumentProbes'] = '1'`) then read `window.__FREDO_HEALTH_PROBE_COUNT__` over a ≥2-interval window ⇒ ≤1 probe-set per 15 000 ms, 0 on a re-render.
- **FS-3 — model-missing leg (F-6b, no code):** set the `models_dir` setting to an empty temp dir under `.opencode/tmp/3052/` with the companion installed ⇒ `companionModel` `down`, overall `degraded`.

## Round-2 results (serving commit `c5a7602`)

All of F-1 … F-9 PASS live; F-3 and F-5 (UNVERIFIED in round 1) are now live-proven via FS-1 / FS-2, and F-6's second leg (model-missing) is live-proven via FS-3. F-8 is PASS on the poll leg with R-6's event clause **re-scoped to poll-only** (FS-5: `llama-server-status` has no Rust `emit` site). Evidence: the round-2 `## Tests Runs` verdict on the feature issue (live receipt via the app-pool `telemetry_spans` stat — the managed `psql` read lever is keychain-blocked in an isolated env, G-375).

---

## Spec #3064 — the telemetry line gains the `degraded` state (live stream health)

> The telemetry subsystem line stops being a two-valued `healthy`/`down` mount constant and
> becomes the three-valued `StreamHealth` (`healthy` | `degraded` | `down`) from the ingest
> liveness heartbeat (#3064). The LED surface, tokens, DOM and composed label are UNCHANGED —
> only the telemetry line's state/word/detail gain `degraded`. Verification policy: LIVE.

- [ ] **F-10 (#3064 REQ-2) — telemetry line `degraded` + "Telemetry stalled".**
  - Data: `FREDO_STREAM_HEALTH_FORCE=degraded` (suppresses the heartbeat; REAL staleness path).
  - Steps: wait > `STREAM_HEARTBEAT_STALE_MS` (15 s); hover `desktop-status-led`; read `health-line-telemetry` + `desktop-status-led-overall`.
  - Expected: `health-line-telemetry` `data-health-state="degraded"` + text contains `Degraded` AND `Telemetry stalled`; `desktop-status-led-overall` NOT `healthy`. Control: unset lever → telemetry `healthy`.
- [ ] **F-11 (#3064 REQ-3) — telemetry line `down` + "Stream stopped".**
  - Data: `FREDO_STREAM_HEALTH_FORCE=down` (the `stream_health` probe returns `Err`).
  - Expected: `health-line-telemetry` `data-health-state="down"` + text contains `Down` AND `Stream stopped`; overall `data-health-state="down"` (telemetry MANDATORY — `fredoHealth.ts:66`). Disclosure (G-376): mapping/render only.
- [ ] **F-12 (#3064 REQ-8) — per-state `data-health-state` + distinct text + aria-label segment.**
  - Data: drive `healthy` (no lever), `degraded`, `down`.
  - Expected: `health-line-telemetry` `data-health-state` ∈ {`healthy`,`degraded`,`down`} with a DISTINCT on-screen text per state (`Streaming`/`Telemetry stalled`/`Stream stopped`); the composed `aria-label` on `desktop-status-led` contains `Agent telemetry: Healthy`/`Agent telemetry: Degraded`/`Agent telemetry: Down`; trigger stays `tabIndex={0}`; no state conveyed by colour alone.
- [ ] **F-13 (#3064 REQ-9 / regression) — inert unset control + neutral states unchanged.**
  - Data: launch WITHOUT the lever; and the `notSetUp`/`unknown` companion/postgres lines (fresh env / in-flight probe).
  - Expected: telemetry `healthy` with no lever (byte-identical to pre-#3064); `notSetUp`/`unknown` lines still NEUTRAL — they never degrade the aggregate (`fredo-health-led` R-7/AC4); the new `degraded` member does not alter that.
- [ ] **F-14 (#3064 ST-4, static/unit pin — NON-AC) — the `degraded` member + aggregate raise.**
  - Data: `apps/ui/src/shared/hooks/__tests__/fredoHealth.test.ts` + `launcherHealthLed.test.tsx`.
  - Expected: `SubsystemHealth` includes `degraded`; `telemetryLine` maps each `StreamHealth` 1:1 (`healthy`→`healthy`/`Streaming`, `degraded`→`degraded`/`Telemetry stalled`, `down`→`down`/`Stream stopped`); `aggregateFredoHealth` raises the overall to `degraded` on a non-neutral `degraded` telemetry line and to `down` on telemetry `down`; `SUBSYSTEM_STATE_WORD.degraded === 'Degraded'`. (`degraded` IS live-reachable via F-10; this pin covers the pure mapping.)
