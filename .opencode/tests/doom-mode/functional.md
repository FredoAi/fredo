# doom-mode — Functional Test Cases (Spec #2968)

> Durable functional suite (feature domain `doom-mode`). One `- [ ]` case per requirement; observable expected outcome per case.
>
> **Verification policy: live** — this feature renders live frames, supervises an OS child process, and performs loopback HTTP round trips; no AC is provable statically. The live-policy Evidence MUST reference `telemetry_spans` via the established non-zero-count + recent `max(ingested_at)` live-pipeline check (app-dock / workspace-layout precedent) at round start AND after the drive. Doom is **row-INDEPENDENT** (it emits NO OTLP spans) — the query is the live-pipeline reference, never a Doom-emitted span. A static-only PASS is a FALSE PASS; the audit gate fails closed. Every process/HTTP wait is bounded (G-263); a console `Error:`/`Uncaught`/`Maximum update depth exceeded` on any leg invalidates that leg.
>
> **Test data (G-172):** STUB = in-repo feature-gated `doom-stub` (ST-8), built `cargo build --features doom-stub`; honors `FREDO_DOOM_STUB_HANG` / `FREDO_DOOM_STUB_EXIT`. ENV overrides injected only via `dev-env.ps1 -Action Up -Spec 2968 -EnvVar "NAME=value"`. Scratch dir `.opencode/tmp/2968/doom-install`. REAL engine only for F-1's frame leg (named blocker; see the plan's Required test data). PG reads use the managed `psql` (G-284; the `telemetry-query` skill is SQLite-only).
>
> Binding names adopted VERBATIM: window label `doom`, URL `index.html?view=doom`; commands `open_doom_window`, `launch_doom_runtime`, `stop_doom_runtime`, `get_doom_status`, `doom_read_state`, `doom_step`, `doom_frame`; testids `doom-root`, `doom-frame-canvas`, `doom-frame-desc`, `doom-status`, `doom-error`, `doom-start-button`, `doom-retry-button`, `doom-step-button`, `doom-state-readout`, `doom-entry-button`, `doom-window-title`; timeouts `DOOM_READY_TIMEOUT_S=30`, `DOOM_STOP_TIMEOUT_S=5`, `DOOM_EXIT_HOOK_BOUND=5`, `DOOM_REQUEST_TIMEOUT_S=10`, `DOOM_FRAME_POLL_MS=66`; event `doom-status-changed`; doc `docs/doom-mode-acquisition.md`.

## Window open + singleton (R-1.1 / R-1.2 / R-1.3)

- [ ] F-1 (R-1.1, AC1): From the pre-feature main window click `doom-entry-button` (then invoke `open_doom_window`). STUB leg first, then the REAL-engine leg.
  - EXPECTED: `launch_doom_runtime` reaches `phase:"ready"` within `DOOM_READY_TIMEOUT_S`; exactly one window label `doom` with URL `index.html?view=doom`; DOM shows `doom-root` and `doom-window-title`="Doom"; `doom-frame-canvas` present with `role="img"` + `aria-label="Doom game view"` + `aria-describedby="doom-frame-desc"`; the VisuallyHidden `doom-frame-desc` exists and its non-visual text updates with the readout. REAL leg: the canvas shows live game pixels — a dense/full-frame diff between two frames `DOOM_FRAME_POLL_MS`-spaced is non-zero over time (G-216/G-213), corroborated by a vision read.
  - Edge: entry reachable from the fresh pre-feature state (G-265); `starting` phase observable; REAL unavailable → named blocker with STUB structural evidence — do NOT gate the lifecycle rows on it.
- [ ] F-2 (R-1.2, AC1): Invoke open twice (entry click → `open_doom_window` again → the doom window's own mount); list windows.
  - EXPECTED: exactly ONE window labeled `doom` after both invocations; the second invocation focuses the existing window (focused, no new webview).
  - Edge: rapid double-click; second invoke while `starting`; main-entry and window-mount triggers converge on one window.
- [ ] F-3 (R-1.3, AC1 continuous): After ready, invoke `launch_doom_runtime` again; read `get_doom_status` + the process inventory.
  - EXPECTED: exactly one engine PID — `pid`/`port` identical before and after the second launch (idempotent healthy early return); exactly one `doom-stub`/engine process.
  - Edge: launch while `starting`; launch while `ready`; launch after `error`.

## State read + step round trip (R-2.1 / R-2.2 / R-2.3)

- [ ] F-4 (R-2.1, AC2): `doom_read_state` against a ready STUB; capture the engine request log / IPC monitor.
  - EXPECTED: exactly ONE `GET /api/state`; `DoomStateView.raw` equals the stub's state JSON verbatim; no second request.
  - Edge: not-ready → typed error, no request; read+step ordering.
- [ ] F-5 (R-2.2, AC2): `doom_step(action)`; capture the request log.
  - EXPECTED: exactly ONE `POST /api/step` with the documented body; `DoomStepResult.state` = the post-step observation (single request).
  - Edge: `action` arg round-trip; step while not-ready → typed error.
- [ ] F-6 (R-2.3, AC2): read state → `doom_step` → read state; compare the advanced field.
  - EXPECTED: post-step observation DIFFERS from pre-step in the engine's advanced field (STUB tick +1); all other fields consistent.
  - Edge: two consecutive steps monotonically advance; step→immediate read; a read alone does not advance.

## Bounded teardown + no orphan (R-3.1 / R-3.2 / R-3.3)

- [ ] F-7 (R-3.1, AC3): With a ready runtime, close the `doom` window; poll the PID.
  - EXPECTED: phase `stopping`→`idle`; engine PID GONE within `DOOM_STOP_TIMEOUT_S` (5 s); no orphan.
  - Edge: graceful STUB exit; hang leg `FREDO_DOOM_STOP_TIMEOUT_S=1` + `FREDO_DOOM_STUB_HANG=1` → `taskkill /T /F` fallback, PID gone within bound (covers `stopTimeout`); close while `starting`.
- [ ] F-8 (R-3.2, AC3): With a ready runtime, exit Fredo (`RunEvent::Exit`); poll the PID.
  - EXPECTED: `stop_doom_on_exit` tears down within `DOOM_EXIT_HOOK_BOUND` (5 s); no engine PID after app exit.
  - Edge: exit while `starting`; exit while hung (hard-kill); existing `llama-server` + PG exit hooks still run.
- [ ] F-9 (R-3.3, AC3 continuous): Run ≥5 open/close cycles; then hard-kill Fredo and relaunch.
  - EXPECTED: zero engine processes after every cycle; no second accumulates; the startup sweep reclaims a hard-killed orphan.
  - Edge: rapid cycles; hard-kill mid-`ready`; PID-reuse safety — `is_doom_image` + `sweep_orphan_with` unit pin (non-AC seam, G-300).

## Error states (R-4.1 / R-4.2 / R-4.3)

- [ ] F-10 (R-4.1, AC4): (a) `FREDO_DOOM_ENGINE_PATH` → nonexistent; (b) `FREDO_DOOM_ARCHIVE_URL` unreachable / `_SHA256` mismatch; (c) STUB + `FREDO_DOOM_STUB_EXIT=1`.
  - EXPECTED: `doom-error` renders a clear message + `doom-retry-button`; no crash/panic; rest of Fredo normal (Mission Monitor renders). Codes: (a) `spawnFailed`, (b) `acquireFailed`, (c) `readyTimeout`|`spawnFailed`.
  - Edge: retry after supplying a valid path recovers; the window is never blank/white; missing vs unbuildable engine distinguished.
- [ ] F-11 (R-4.2, AC4): `FREDO_DOOM_IWAD_PATH` → missing file.
  - EXPECTED: `doom-error` with a clear message; code `notConfigured`; no crash; rest of Fredo normal.
  - Edge: retry after supplying a WAD recovers; the corrupt-WAD leg has no in-repo lever → scoped as a static pin (non-AC, G-300).
- [ ] F-12 (R-4.3, AC4): `FREDO_DOOM_READY_TIMEOUT_S=2` + STUB that never answers `/api/state` (`FREDO_DOOM_STUB_HANG=1`).
  - EXPECTED: within the short bound, code `readyTimeout`; the spawned child is KILLED (PID gone, no orphan); the window shows the typed error; never a left-running "pending" engine.
  - Edge: the engine answers just before the timeout (race); timeout while the window is closing.

## QA-added contract edges (G-300)

- [ ] F-14 (R-4.x, QA-added): Induce an engine HTTP failure AFTER ready via `FREDO_DOOM_STUB_FAIL=step` (STUB returns non-2xx).
  - EXPECTED: `doom_read_state`/`doom_step`/`doom_frame` map non-2xx/timeout/connection failure to `requestFailed`; the window shows the typed error; no crash; the canvas keeps the LAST rendered frame across a transient `doom_frame` failure (never blank) with the transient reconnecting note.
  - Lever (G-300): ST-8 endpoint-fail flag `FREDO_DOOM_STUB_FAIL=step` (returns non-2xx) — binding (added to the ST-8 line + the binding env-override list). This row is now LIVE-verifiable: set the flag, drive `doom_step`, and assert the typed `requestFailed` mapping + the retained last frame live — no longer a static/unit pin.
- [ ] F-15 (contract, QA-added): IPC monitor + `doom-status-changed` across launch→ready→stop.
  - EXPECTED: the event fires with `{phase,port,pid,lastError,code}` on each transition; phases observed `idle`→`starting`→`ready`→`stopping`→`idle` (and `→error` on a failure leg).
  - Lever: the env overrides drive the `error` transition; the event monitor captures the payload. Non-AC contract pin.

## Acquisition decision doc (R-5.1)

- [ ] F-13 (R-5.1, AC5): Read `docs/doom-mode-acquisition.md`; cross-check against ST-1's raw spike captures.
  - EXPECTED: the doc records the engine acquisition decision, the WAD decision (Freedoom), the GPL-2.0 posture, the pinned URL + SHA-256, the exact Windows build recipe, and the launch argv — reviewable and reproducible; numbers match ST-1 captures (no drift).
  - Edge: no prebuilt release → user-supplied + build-recipe fallback documented; doc/pins consistent with the shipped `acquisition.rs` constants.

## Mission-Monitor end-to-end smoke row (REQUIRED, human directive)

- [ ] F-MM (mission-monitor smoke row): Boot the RUNNING app end-to-end (PG-default); seed one qualifying session, then assert the list.
  - EXPECTED: (a) the app boots on the **PG-default** path (`storage_engine_status` = PostgreSQL / PG supervisor ready); (b) the Mission Monitor session list renders from the CURRENT backend declared `sessions` rollup — `MissionMonitorPanel` calls `useDeliverySessions()` (`apps/ui/src/features/mission-monitor/components/MissionMonitorPanel.tsx:735-746`), which reads the `feature` table `sessions` (`MISSION_MONITOR_SESSIONS_REF`, `apps/ui/src/features/mission-monitor/hooks/useSessionHistory.ts:36-40`) via `useFeatureRead`+`useFeatureWatch` and applies `sessionRollupQualifies` (`useSessionHistory.ts:46-54`: `visibleTurnCount > 0 || (nonSubagentChatRowCount > 0 && userDispatchCount > 0)`), the frontend half of the backend projection predicate (`apps/tauri/src-tauri/src/infrastructure/feature_data/session_rollup.rs:44-46`); `SessionHistoryDrawer` renders it (`MissionMonitorPanel.tsx:945-960`). SEED LEVER: `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` (stable session `e2e-copilot2933`) → the running app's real OTLP/HTTP receiver (`127.0.0.1:4318/v1/traces`) → canonical chat rows → the `sessions` rollup projects a qualifying row. The fixture guard asserts the DECLARED `sessions` row for `e2e-copilot2933` has `visibleTurnCount ≥ 1` (its completed `chat` spans carry non-blank assistant output — `copilot-exchange.fixture.json:73-97`) BEFORE the list is asserted (G-285: the fixture satisfies the rollup's predicate, not merely a 200); then `SessionHistoryDrawer` shows ≥1 session row and the canvas shows ≥1 node for the selected session; (c) the new Doom feature is reachable — `doom-entry-button` opens the `doom` window.
  - Edge: boot with no pre-existing Doom state; PG-default (not SQLite); the seeded `e2e-copilot2933` session is idempotent (stable keys — repeat runs upsert, never duplicate); after Doom open/close the rest of the app is unaffected.

## Non-functional (N-1..N-7)

- [ ] N-1 (no orphan): after every leg — close, exit, start-failure, hard-kill+relaunch — zero `doom` engine processes; the startup sweep is the backstop.
- [ ] N-2 (bounded times): startup ≤ `DOOM_READY_TIMEOUT_S`, graceful stop ≤ `DOOM_STOP_TIMEOUT_S`, exit hook ≤ `DOOM_EXIT_HOOK_BOUND`, each HTTP request ≤ `DOOM_REQUEST_TIMEOUT_S`; no unbounded wait anywhere.
- [ ] N-3 (no app regression): Mission Monitor, the `terminal` window, `llama-server`, and the PG supervisor exit hooks behave identically; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] N-4 (loopback-only): the engine binds `127.0.0.1` only; no public interface; the webview CSP is unchanged (all engine HTTP is Rust-side).
- [ ] N-5 (frame budget): `doom_frame` polls at `DOOM_FRAME_POLL_MS` (~15 fps); a dropped frame degrades to the last rendered frame and never blocks the UI thread.
- [ ] N-6 (packaging): the installer ships no GPL engine binary and no non-open WAD (~0 installer growth) — static/packaging check against the bundle.
- [ ] N-7 (live-pipeline receipt): `telemetry_spans` non-zero with a recent `max(ingested_at)` at round start AND after the drive (PG via managed `psql`, or SQLite with a disclosed substitution).

**`DoomErrorCode` coverage:** `notConfigured`→F-11 · `acquireFailed`→F-10b · `spawnFailed`→F-10a · `readyTimeout`→F-10c/F-12 · `stopTimeout`→F-7 hang leg · `requestFailed`→F-14 (QA-added, lever above).
