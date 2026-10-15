# Functional — stream-health

Durable suite for the ingest-pipeline liveness heartbeat (feature #3064). One `- [ ]` case per
EARS requirement (REQ-1..REQ-9), each with an observable expected outcome and its required test
data. **Verification policy: live** — the testing exit gate / audit fail-closed unless the
tester's Evidence references a `telemetry_spans` live-query result (the independence receipt,
F-6) PLUS the LED `data-health-state` captured per state.

Binding names (G-255 — adopt exactly): `StreamHealth = 'healthy' | 'degraded' | 'down'`;
`StreamHealthHeartbeat` (`seq`, `ingestConnected`, `ageMs`, `emittedAtMs`) on the
`fredo-stream-event` channel under field `streamHealth`; `EventBus::emit_stream_health`;
command `stream_health` → `StreamHealthSnapshot { seq, ingestConnected, ageMs, forced }`;
`useStreamHealth()` → `{ health, isConnected }`; `useStreamHealthProducer(adapter)` →
`{ onHeartbeat }`; pure module `apps/ui/src/shared/hooks/streamHealth.ts`. Cadence:
`STREAM_HEARTBEAT_INTERVAL_MS = 5000`, `STREAM_HEARTBEAT_STALE_MS = 15000`,
`STREAM_HEALTH_CHECK_INTERVAL_MS = 5000`. REUSE (no new DOM/testid): `desktop-status-led`,
`desktop-status-led-overall` + `data-health-state`, `health-line-telemetry` + `data-health-state`
∈ {`healthy`,`degraded`,`down`}.

> **G-376 disclosure (binding).** A genuine telemetry outage is not tester-drivable, so every
> `degraded`/`down` case drives the inert-by-default in-repo lever `FREDO_STREAM_HEALTH_FORCE`
> AND pairs the unset control. `degraded` suppresses heartbeat emission (the REAL staleness path
> runs); `down` makes the `stream_health` probe return `Err`; the frontend runtime mirror
> verifies the state MAPPING/RENDER, not a real IPC outage.

## Cases

- [ ] **F-1 (REQ-1) — live pipeline ⇒ `healthy` + all consumers connected.**
  - Data: live dev app; backend ingest pipeline live (OTLP receiver bound 127.0.0.1:4317/4318).
  - Steps: read the `stream_health` probe; observe `fredo-stream-event` `streamHealth` envelopes; read the LED + consumers.
  - Expected: `stream_health` → `ok:true`, `ingestConnected:true`, `ageMs ≤ STREAM_HEARTBEAT_STALE_MS`; `streamHealth.seq` advances every ≤ 5000 ms; `health-line-telemetry` `data-health-state="healthy"` + text `Agent telemetry Healthy Streaming`; `desktop-status-led-overall` `data-health-state="healthy"`; `useStreamHealth().isConnected===true`; `mm-watch-disconnected` absent; Dev Mode badge `live`. PASS = all; FAIL = any.

- [ ] **F-2 (REQ-2) — heartbeat stall (probe Ok) ⇒ `degraded` + "Telemetry stalled".**
  - Data: launch with `FREDO_STREAM_HEALTH_FORCE=degraded` (suppresses heartbeat emission → REAL staleness path).
  - Steps: wait > `STREAM_HEARTBEAT_STALE_MS` (15 s); read the probe, the LED, the consumers.
  - Expected: no new `streamHealth` envelopes; probe still `ok:true` (IPC alive) but `ageMs > STREAM_HEARTBEAT_STALE_MS` → `deriveStreamHealth` = `degraded` within ONE `STREAM_HEALTH_CHECK_INTERVAL_MS`; `health-line-telemetry` `data-health-state="degraded"` + text contains `Degraded` AND `Telemetry stalled`; `desktop-status-led-overall` NOT `healthy`; aria-label `Agent telemetry: Degraded`; `mm-watch-disconnected` present; Dev Mode `offline`. PASS = `degraded` with probe Ok; FAIL = telemetry `down` or no degradation.
  - Control: relaunch WITHOUT the lever → `healthy` (F-4).

- [ ] **F-3 (REQ-3) — probe `Err` ⇒ `down` + "Stream stopped".**
  - Data: launch with `FREDO_STREAM_HEALTH_FORCE=down` (the `stream_health` command returns `Err`).
  - Steps: read the probe, the LED, the consumers.
  - Expected: the bounded probe fails (`Err`) → `deriveStreamHealth` = `down`; `health-line-telemetry` `data-health-state="down"` + text contains `Down` AND `Stream stopped`; `desktop-status-led-overall` `data-health-state="down"` (telemetry is MANDATORY — `fredoHealth.ts:66`); aria-label `Agent telemetry: Down`; `mm-watch-disconnected` present; Dev Mode `offline`. PASS = `down` + `Stream stopped`; FAIL = any other state.
  - Disclosure (G-376): verifies mapping/render, not a real IPC outage. Control: relaunch WITHOUT the lever → `healthy` (F-4).

- [ ] **F-4 (REQ-4) — recovery `degraded`/`down` → `healthy` within one interval.**
  - Data: start from F-2 (`degraded`) and F-3 (`down`); clear the lever (unset) or resume heartbeat emission.
  - Steps: observe within one interval; a fresh heartbeat is delivered on the channel.
  - Expected: status returns to `healthy`; `useStreamHealth().isConnected===true`; all three consumers read connected (`health-line-telemetry` `healthy`, `mm-watch-disconnected` absent, Dev Mode `live`). Event-driven recovery: a fresh `streamHealth` heartbeat sets health immediately via `onHeartbeat` (before the next tick). PASS = `healthy` within one interval from BOTH `degraded` and `down`.
  - Edge: recovery from `down` needs a SUCCESSFUL probe (not just a heartbeat); rapid `degraded`→`healthy`→`degraded` flap (no stuck state).

- [ ] **F-5 (REQ-5) — OTLP not-connected while heartbeats continue ⇒ `degraded`.**
  - Data: occupy the OTLP HTTP port `127.0.0.1:4318` (dummy listener) BEFORE launch so the receiver's bind/ingest path reports not-connected; heartbeats continue.
  - Steps: read the probe + the LED.
  - Expected: `stream_health` returns `ok:true` but `ingestConnected:false` → `deriveStreamHealth` = `degraded`; `health-line-telemetry` `degraded` + `Telemetry stalled`; overall NOT `healthy`. PASS = `degraded` with probe Ok and `ingestConnected:false`.
  - G-300 fallback: if the port-occupation lever cannot induce `ingestConnected:false` on the shipped path, run the static pin `deriveStreamHealth({ok:true, ageMs:0, ingestConnected:false})==='degraded'` (marked NON-AC) and record a named blocker. Control: port free → `ingestConnected:true` → `healthy`.

- [ ] **F-6 (REQ-6, AC5) — idle ≠ outage; liveness independent of span flow.**
  - Data: live dev app; leave it idle (no agent producing telemetry) for ≥ 3 heartbeat intervals (≥ 15 s; prefer ≥ 30 s).
  - Steps: capture `telemetry_spans` count at T0 and T1 (the idle window) and `stream_health.seq` at T0 and T1.
  - Expected: `stream_health.seq` ADVANCES across the window while the `telemetry_spans` count is STATIC (no new spans) — the independence receipt; `health-line-telemetry` stays `healthy` throughout; `isConnected===true`; NEVER `degraded`/`down`. PASS = healthy throughout with seq advancing and span count static.
  - **Live evidence anchor (required):** the `telemetry_spans` count-unchanged receipt + the `stream_health.seq` advance. Edge: long idle spanning the stale window boundary; idle after an active burst; idle with zero sessions in the store.

- [ ] **F-7 (REQ-7) — Mission Monitor banner + Dev Mode badge on `degraded`/`down`.**
  - Data: from F-2 (`degraded`) and F-3 (`down`).
  - Steps: inspect Mission Monitor and Dev Mode.
  - Expected: `[data-testid="mm-watch-disconnected"]` renders with text `Live updates disconnected — showing stored sessions.` AND the Dev Mode badge reads `offline`, in BOTH `degraded` and `down`. On recovery both revert (`live`, banner absent). PASS = both present in each state.
  - Negative control: banner ABSENT while `healthy`. G-273 owner: ST-2 (consumers derive `isConnected = health === 'healthy'`; no component change — `MissionMonitorPanel.tsx:1047`, `useDevModeStream.ts:84,147`).

- [ ] **F-8 (REQ-8) — state by TEXT + composed aria-label, never colour alone.**
  - Data: drive `healthy` (F-1), `degraded` (F-2), `down` (F-3).
  - Steps: for each state, Tab to `desktop-status-led`; read the composed `aria-label`, the tooltip text, and `data-health-state`.
  - Expected: trigger keeps `role="status"`, `aria-live="polite"`, `aria-atomic="true"`, `tabIndex={0}`; composed aria-label = `Fredo health: <Overall> — Agent telemetry: <s>; Llama server: <s>; Companion model: <s>; Postgres: <s>`; the telemetry line renders DISTINCT text per state (`Streaming`/`Telemetry stalled`/`Stream stopped`) AND `data-health-state`; no state is conveyed by colour alone. PASS = all three states have distinct text + label. G-273 owner: ST-4.

- [ ] **F-9 (REQ-9) — lever semantics + inertness (paired unset control).**
  - Data: `FREDO_STREAM_HEALTH_FORCE` = `degraded`, then `down`, then unset / `""` (blank) / `unknown` / `bogus`; also the runtime mirror `window.__FREDO_STREAM_HEALTH_FORCE__` / `sessionStorage['fredoStreamHealthForce']`.
  - Steps: for each value, read the probe + LED.
  - Expected: `degraded` suppresses heartbeat emission + status `degraded`; `down` makes `stream_health` return `Err` + status `down`; unset/blank/`unknown`/`bogus` are INERT (byte-identical to no lever: heartbeats emit, status `healthy`). Backend unit: `stream_health_force()` → `None` for unset/blank/unknown. Frontend `resolveStreamHealthForce()` resolves the same and is inert unset. PASS = all four inert tokens leave status `healthy`.
  - Edge: blank string; unknown token; runtime mirror set MID-SESSION (read on the next bounded tick).

## Non-functional

- [ ] **N-1 (bounded polling) — ONE interval, ≤1 IPC probe/tick, zero IPC on re-render.**
  - Data: `tauri_ipc_monitor` / `tauri_ipc_get_captured` over ≥2 intervals (`STREAM_HEALTH_CHECK_INTERVAL_MS = 5000`).
  - Expected: exactly ONE bounded interval while mounted; ≤1 `stream_health` invoke per tick; ZERO `stream_health` invokes on a re-render (stable callbacks; effect depends only on stable refs). PASS = counts hold.

- [ ] **N-2 (no re-render loop) — console clean; derived via `useMemo`/`useSyncExternalStore`.**
  - Data: `tauri_read_logs(source="console", lines=50)` across state transitions (healthy→degraded→down→healthy).
  - Expected: no `Error:` / `Uncaught` / `Maximum update depth exceeded`; display state derived via `useMemo`/`useSyncExternalStore`, never `useEffect`+`setState` on a length/object-ref dep (#523). PASS = clean console.

- [ ] **N-3 (token-only colours; no new DOM) — reuse existing testids + tokens.**
  - Data: DOM snapshot of the LED tooltip per state.
  - Expected: `desktop-status-led`, `desktop-status-led-overall` + `data-health-state`, `health-line-telemetry` + `data-health-state` ∈ {`healthy`,`degraded`,`down`} are REUSED; a DOM-snapshot diff asserts NO new testid; colours via `healthToken` → `var(--status-warning)`/`var(--status-error)`/`var(--accent-primary)`; no hardcoded hex/rgba; no `var(--x)NN` alpha-append; tints/halos via `tint()`/`color-mix()`. PASS = no new testid + tokens only.

- [ ] **N-4 (single emission path + remount persistence) — backend emit + module-scoped freshness.**
  - Data: static pin on the spec diff; a remount cycle (close/reopen a consumer).
  - Expected: the heartbeat leaves the backend ONLY via `EventBus::emit_stream_health` (never `app_handle.emit`); `emit_row_delivery_batch` and the row path untouched; last-heartbeat freshness is module-scoped in `StreamContext` (not a component ref) — a remount does NOT reset freshness. PASS = both hold.

## Induction levers (all in-repo; inert when unset — G-275 / G-300)

- **`degraded` (F-2/F-9):** `FREDO_STREAM_HEALTH_FORCE=degraded` (backend env) — the publisher loop skips emission, so the REAL staleness path runs. Frontend mirror: `VITE_FREDO_STREAM_HEALTH_FORCE=degraded`, `window.__FREDO_STREAM_HEALTH_FORCE__='degraded'`, `sessionStorage['fredoStreamHealthForce']='degraded'`.
- **`down` (F-3/F-9):** `FREDO_STREAM_HEALTH_FORCE=down` — the `stream_health` command returns `Err` (simulated IPC outage; mapping/render only — G-376).
- **Unset control (F-2/F-3/F-5/F-9):** relaunch WITHOUT the lever (or with `""`/`unknown`/`bogus`) → heartbeats emit, status `healthy`.
- **`ingestConnected:false` (F-5):** occupy `127.0.0.1:4318` before launch; fallback static pin if unreachable (G-300).

## Live evidence anchor

- F-6 must carry a `telemetry_spans` live-query result showing the span count UNCHANGED across the idle window while `stream_health.seq` advances (embedded PostgreSQL `fredo` DB; disclose the port). Span-producing lever (G-256): a real agent drive (Run CLI) or an active companion generation — NOT `fredo emit` (writes rows, not spans).
- F-1/F-2/F-3/F-8 must capture the LED `data-health-state` + text per state (DOM snapshot + screenshot).
