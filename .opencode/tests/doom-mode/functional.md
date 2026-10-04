# doom-mode — Functional Test Cases (Spec #2968)

> Durable functional suite (feature domain `doom-mode`). One `- [ ]` case per requirement; observable expected outcome per case.
>
> **Verification policy: live** — this feature renders live frames from a real OS child process, supervises that process, and performs loopback HTTP round trips; no AC is provable statically. The live-policy Evidence MUST reference `telemetry_spans` via the established non-zero-count + recent `max(ingested_at)` live-pipeline check (app-dock / workspace-layout precedent) at round start AND after the drive. Doom is **row-INDEPENDENT** (it emits NO OTLP spans) — the query is the live-pipeline reference, never a Doom-emitted span. The prior round used `telemetry_get_stats` with the managed-`psql` "too many clients" fallback; that substitution MUST be disclosed. A static-only PASS is a FALSE PASS; the audit gate fails closed. Every process/HTTP wait is bounded (G-263); a console `Error:`/`Uncaught`/`Maximum update depth exceeded` on any leg invalidates that leg.
>
> **Real-engine scope (BINDING human directive):** the engine MUST be the real **RESTful-DOOM** (`mkschreder/restful-doom`, Chocolate-Doom-derived), **built from source** by `scripts/doom/build-restful-doom.ps1` (ST-2) and staged at `<install_dir>/engine/restful-doom.exe`. The AC1 live-frame, AC2 round-trip, and AC3 no-orphan legs run this binary; a **stub-only PASS is a FALSE PASS (G-033)**. The stub is used ONLY for deterministic AC4 error-path pins.
>
> **Test data (G-172):** REAL engine via the ST-2 build script (staged `restful-doom.exe`); Freedoom IWAD 0.13.0 (SHA-256 `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59`) via the pinned `acquire_iwad`; STUB = in-repo feature-gated `doom-stub`, built `cargo build --features doom-stub`, honoring `FREDO_DOOM_STUB_HANG` / `FREDO_DOOM_STUB_EXIT` / `FREDO_DOOM_STUB_FAIL`; fixtures staged by `scripts/doom/stage-doom-fixture.ps1` (ST-6) into `.opencode/tmp/2968/fixtures/`. ENV overrides injected only via the dev-environment skill (`dev-env.ps1 -Action Up -Spec 2968 -EnvVar "NAME=value"`). Scratch dir `.opencode/tmp/2968/doom-install`. PG reads use the managed `psql` (G-284; the `telemetry-query` skill is SQLite-only).
>
> Binding names adopted VERBATIM: engine `restful-doom.exe`; fields `DoomLaunchResult.enginePath` / `DoomStatus.enginePath` (camelCase); error code `frameNotReady` (`GET /api/frame` HTTP 503 = transient); env seams `FREDO_DOOM_REQUIRE_REAL_ENGINE`, `FREDO_DOOM_BUILD_OFFLINE`, `FREDO_DOOM_ENGINE_PATH`, `FREDO_DOOM_IWAD_PATH`, `FREDO_DOOM_INSTALL_DIR`, `FREDO_DOOM_READY_TIMEOUT_S`, `FREDO_DOOM_STOP_TIMEOUT_S`, `FREDO_DOOM_ARCHIVE_URL`/`_SHA256`/`_BYTES`; window label `doom`, URL `index.html?view=doom`; commands `open_doom_window`, `launch_doom_runtime`, `stop_doom_runtime`, `get_doom_status`, `doom_read_state`, `doom_step`, `doom_frame`; testids `doom-root`, `doom-window-title`, `doom-status`, `doom-frame-canvas`, `doom-frame-desc`, `doom-start-button`, `doom-error`, `doom-retry-button`, `doom-state-readout`, `doom-step-button`, `doom-frame-reconnecting`, `doom-entry-button`; timeouts `DOOM_READY_TIMEOUT_S=30`, `DOOM_STOP_TIMEOUT_S=5`, `DOOM_EXIT_HOOK_BOUND=5`, `DOOM_REQUEST_TIMEOUT_S=10`, `DOOM_FRAME_POLL_MS=66`; event `doom-status-changed`; doc `docs/doom-mode-acquisition.md`; launch argv `restful-doom.exe -apilockstep -noblit -nosound -nomusic -iwad <freedoom1.wad> -warp 1 1 -skill 3 -apiport <port>`.

## Real engine — build, identity, live frame (R-1.1 / R-5.1)

- [ ] F-1 (R-1.1, AC1) **REAL-ENGINE LIVE FRAME — REQUIRED.** Build via `scripts/doom/build-restful-doom.ps1` (ST-2) → stage `<install_dir>/engine/restful-doom.exe`; launch `launch_doom_runtime`; open the `doom` window; capture screenshot + DOM + process inventory.
  - EXPECTED: (a) `DoomLaunchResult.enginePath` basename == `restful-doom.exe`; (b) `DoomStatus.enginePath` same; (c) `tasklist /FI "IMAGENAME eq restful-doom.exe"` lists a live PID equal to the reported `pid`; (d) `doom-frame-canvas` paints REAL game pixels — a dense/full-frame diff between two `DOOM_FRAME_POLL_MS`-spaced frames is non-zero over time (G-216/G-213), corroborated by a vision read + screenshot receipt saved under `.opencode/tmp/2968/e2e/`; (e) `doom-root` + `doom-window-title`="Doom" present; canvas `role="img"` + `aria-label="Doom game view"` + `aria-describedby="doom-frame-desc"`; (f) no second OS window from SDL video (ST-5).
  - Edge: entry reachable from the fresh pre-feature state (G-265); `starting` phase observable; **a stub-only receipt is a FALSE PASS (G-033) — FAIL**.
- [ ] F-16 (R-5.1, AC5) **Build script.** Run `scripts/doom/build-restful-doom.ps1` in MSYS2 MINGW64; re-run.
  - EXPECTED: exit 0; stdout is the staged path (one line); `<install_dir>/engine/restful-doom.exe` exists and is a PE image; idempotent re-run.
  - Edge: toolchain absent → exit 2 (TOOLING GAP, block, G-172); clone/configure/make fail → exit 3/4 with a typed message.
- [ ] F-22 (ST-6) **Fixture staging.** Run `scripts/doom/stage-doom-fixture.ps1`; print the env exports.
  - EXPECTED: stages the real engine + Freedoom into `.opencode/tmp/2968/fixtures/` and emits the exact env exports; the staged engine launches and renders.
  - Edge: re-run idempotent; no asset committed or hunted outside the repo (G-172).
- [ ] F-17 (R-5.1, AC4 build-failure lever) `FREDO_DOOM_BUILD_OFFLINE=1` + run the build script.
  - EXPECTED: non-zero exit (3) with a typed "offline" message; NO partial/incorrect engine staged; any previously staged engine untouched.
  - Edge: re-run online recovers; failure never leaves a corrupt `restful-doom.exe`.

## Window open + singleton + continuous loop (R-1.1 / R-1.2 / R-1.3 / R-1.4)

- [ ] F-2 (R-1.2, AC1) Invoke open twice (entry click → `open_doom_window` again → the doom window's own mount); list windows.
  - EXPECTED: exactly ONE window labeled `doom` after both invocations; the second focuses the existing window (focused, no new webview, no second engine).
  - Edge: rapid double-click; second invoke while `starting`; main-entry and window-mount triggers converge on one window.
- [ ] F-3 (R-1.3, AC1 continuous) After ready, sample `doom-frame-canvas` across ≥2 s; invoke `launch_doom_runtime` again; read `get_doom_status` + process inventory.
  - EXPECTED: `GET /api/frame` polled at `DOOM_FRAME_POLL_MS` (66 ms, ~15 fps); the canvas advances (rendered-over-time pixel delta, G-216); exactly one engine PID — `pid`/`port` identical before and after the second launch (idempotent healthy early return).
  - Edge: a dropped frame degrades to the LAST rendered frame (never blanks); re-launch while `starting`/`ready`/`error`.
- [ ] F-4 (R-1.4) **frameNotReady transient.** Induce a `GET /api/frame` HTTP 503 while polling.
  - EXPECTED: 503 maps to `frameNotReady` (transient): the poll loop KEEPS RUNNING, `doom-frame-reconnecting` shows, and the window does **NOT** enter `error`; frames resume on the next 200; the canvas keeps the last frame.
  - Edge: repeated 503s never latch `error`; natural lever = the real engine's pre-graphics-init 503 window (ST-4); deterministic lever = the ST-6 stub frame-503 seam (requested — see the plan's Discussion point).

## State read + step round trip (R-2.1 / R-2.2 / R-2.3)

- [ ] F-5 (R-2.1, AC2) `doom_read_state` against a ready engine; capture the engine request log / IPC monitor.
  - EXPECTED: exactly ONE `GET /api/state`; `DoomStateView.raw` equals the engine's state JSON verbatim; no second request.
  - Edge: not-ready → typed error, no request; read+step ordering.
- [ ] F-6 (R-2.2, AC2) `doom_step({tics:1, actions:[]})`; capture the request log.
  - EXPECTED: exactly ONE `POST /api/step` with body `{tics, actions}`; `DoomStepResult.state` = the post-step observation (single request).
  - Edge: `actions` arg round-trip; step while not-ready → typed error, no request.
- [ ] F-7 (R-2.3, AC2) **state→step round trip — REQUIRED (real engine).** read state → `doom_step` → read state; compare the advanced field.
  - EXPECTED: post-step `tic` strictly GREATER than the pre-step `tic` (state genuinely advanced); all other fields consistent; IPC shows exactly one GET + one POST.
  - Edge: two consecutive steps monotonically advance; step→immediate read; a read alone does not advance.

## Bounded teardown + no orphan (R-3.1 / R-3.2 / R-3.3)

- [ ] F-8 (R-3.1, AC3) **Bounded stop / no orphan — REQUIRED (real engine).** With a ready runtime, close the `doom` window; poll the PID.
  - EXPECTED: phase `stopping`→`idle`; engine PID GONE within `DOOM_STOP_TIMEOUT_S` (5 s); **zero** `restful-doom.exe` after.
  - Edge: hang leg `FREDO_DOOM_STOP_TIMEOUT_S=1` + `FREDO_DOOM_STUB_HANG=1` → `taskkill /T /F` fallback, PID gone within the bound (covers `stopTimeout`); close while `starting`.
- [ ] F-9 (R-3.2, AC3) With a ready runtime, exit Fredo (`RunEvent::Exit`); poll the PID.
  - EXPECTED: `stop_doom_on_exit` tears down within `DOOM_EXIT_HOOK_BOUND` (5 s); no engine PID after app exit.
  - Edge: exit while `starting`; exit while hung (hard-kill); existing `llama-server` + PG exit hooks still run.
- [ ] F-10 (R-3.3, AC3 continuous) Run ≥5 open/close cycles; then hard-kill Fredo and relaunch.
  - EXPECTED: zero engine processes after every cycle; no second accumulates; the startup sweep reclaims a hard-killed orphan and never kills a reused unrelated PID.
  - Edge: rapid cycles; hard-kill mid-`ready`; PID-reuse safety — `is_doom_image` + `sweep_orphan_with` unit pin (non-AC seam, G-300).

## Error states (R-4.1 / R-4.2 / R-4.3 / R-4.4 / R-4.5)

- [ ] F-11 (R-4.1, AC4) **Missing/invalid engine.** `FREDO_DOOM_ENGINE_PATH` → a nonexistent/invalid exe (fixture dir `.opencode/tmp/2968/fixtures/`).
  - EXPECTED: `doom-error` renders a clear message + `doom-retry-button`; code `notConfigured`/`spawnFailed`; no crash/panic; rest of Fredo normal.
  - Edge: retry after supplying a valid path recovers; the window is never blank/white.
- [ ] F-12 (R-4.1 + ST-3, AC4) **Anti-stub refusal.** `FREDO_DOOM_REQUIRE_REAL_ENGINE=1` + `FREDO_DOOM_ENGINE_PATH` = the built stub.
  - EXPECTED: the runtime REFUSES an engine whose basename ≠ `restful-doom.exe` (typed error); the stub is never launched-as-real; a stub PASS can never masquerade (G-033).
  - Edge: env unset → inert; refusal does not crash; the real path still launches after refusal.
- [ ] F-13 (R-4.3, AC4) `FREDO_DOOM_READY_TIMEOUT_S=2` + STUB that never answers `/api/state` (`FREDO_DOOM_STUB_HANG=1`).
  - EXPECTED: within the short bound, code `readyTimeout`; the spawned child is KILLED (PID gone, no orphan); the window shows the typed error; never a left-running "pending" engine.
  - Edge: the engine answers just before the timeout (race); timeout while the window is closing.
- [ ] F-14 (R-4.4, AC4) Induce an engine HTTP failure AFTER ready via `FREDO_DOOM_STUB_FAIL=step` (STUB returns non-2xx).
  - EXPECTED: `doom_read_state`/`doom_step`/`doom_frame` map non-2xx/timeout/connection failure to `requestFailed`; the window shows the typed error; no crash; the canvas keeps the LAST rendered frame (never blank) with the reconnecting note.
  - Lever (G-300): ST-8 endpoint-fail flag `FREDO_DOOM_STUB_FAIL=step`.
- [ ] F-15 (R-4.5, AC4) While any `doom` error state is shown, drive Mission Monitor + the main window.
  - EXPECTED: the rest of Fredo is fully functional; only the `doom` window is affected; console clean.
  - Edge: the error state does not block the main webview; exit hooks still work from the error state.
- [ ] F-18 (R-4.1, AC4) **Acquire failure.** `FREDO_DOOM_ARCHIVE_URL` unreachable + `_SHA256`/`_BYTES` set.
  - EXPECTED: code `acquireFailed`; fail-closed (no partial binary used); clear message; no crash.
  - Edge: URL reachable but SHA-256 mismatched → `acquireFailed`; missing `_BYTES` → refused.
- [ ] F-19 (R-4.1, AC4) **Missing IWAD.** `FREDO_DOOM_IWAD_PATH` → missing file.
  - EXPECTED: `doom-error` with a clear message; code `notConfigured`; no crash; rest of Fredo normal.
  - Edge: retry after supplying a WAD recovers; the corrupt-WAD leg has no in-repo lever → scoped as a static pin (non-AC, G-300).

## QA-added contract edges (G-300)

- [ ] F-23 (contract, QA-added) IPC monitor + `doom-status-changed` across launch→ready→stop.
  - EXPECTED: the event fires with `{phase,port,pid,enginePath,lastError,code}` on each transition; phases observed `idle`→`starting`→`ready`→`stopping`→`idle` (and `→error` on a failure leg).
  - Lever: the env overrides drive the `error` transition; the event monitor captures the payload. Non-AC contract pin.

## Acquisition decision doc (R-5.2)

- [ ] F-20 (R-5.2, AC5) **Decision-doc content.** Read `docs/doom-mode-acquisition.md`; cross-check against the ST-1 captures + the ST-2 script.
  - EXPECTED: the doc records the **build-from-source reality** — the pinned fork commit, the MSYS2 toolchain/deps, the exact launch argv (`-apiport`), the Freedoom 0.13.0 SHA-256 pin, and the GPL/packaging posture (installer ships no GPL binary; engine staged at dev/QA time); §2.2 "user-supplied / runtime-download deferred" is marked SUPERSEDED; numbers match ST-1 (no drift).
  - Edge: doc/pins consistent with the shipped `acquisition.rs` constants; no stale "user-supplied" as the primary decision.

## Mission-Monitor end-to-end smoke row (REQUIRED, human directive)

- [ ] F-MM (mission-monitor smoke row): Boot the RUNNING app end-to-end (PG-default); seed one qualifying session, then assert the list.
  - EXPECTED: (a) the app boots on the **PG-default** path (`storage_engine_status` = PostgreSQL / PG supervisor ready); (b) the Mission Monitor session list renders from the CURRENT backend declared `sessions` rollup — `MissionMonitorPanel` calls `useDeliverySessions()` (`apps/ui/src/features/mission-monitor/components/MissionMonitorPanel.tsx:872`), which reads the `feature` table `sessions` (`MISSION_MONITOR_SESSIONS_REF`, `apps/ui/src/features/mission-monitor/hooks/useSessionHistory.ts:36-40`) via `useFeatureRead`+`useFeatureWatch` and applies `sessionRollupQualifies` (`useSessionHistory.ts:46-54`: `visibleTurnCount > 0 || (nonSubagentChatRowCount > 0 && userDispatchCount > 0)`), the frontend half of the backend projection predicate (`apps/tauri/src-tauri/src/infrastructure/feature_data/session_rollup.rs:45`); `SessionHistoryDrawer` renders it (`MissionMonitorPanel.tsx:1170`). SEED LEVER: `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` (stable session `e2e-copilot2933`) → the running app's real OTLP/HTTP receiver (`127.0.0.1:4318/v1/traces`) → canonical chat rows → the `sessions` rollup projects a qualifying row. The fixture guard asserts the DECLARED `sessions` row for `e2e-copilot2933` has `visibleTurnCount ≥ 1` BEFORE the list is asserted (G-285: the fixture satisfies the rollup's predicate, not merely a 200); then `SessionHistoryDrawer` shows ≥1 session row and the canvas shows ≥1 node for the selected session; (c) the new Doom feature is reachable — `doom-entry-button` opens the `doom` window.
  - Edge: boot with no pre-existing Doom state; PG-default (not SQLite); the seeded `e2e-copilot2933` session is idempotent (stable keys — repeat runs upsert, never duplicate); after Doom open/close the rest of the app is unaffected.

## Non-functional (N-1..N-7)

- [ ] F-21 (live-pipeline receipt) Query `telemetry_spans` via the app-pool path at round start AND after the drive.
  - EXPECTED: NON-ZERO `telemetry_spans` with a recent `max(ingested_at)` BOTH times (the pipeline is alive; Doom emits none).
  - Edge: managed-`psql` "too many clients" → `telemetry_get_stats` fallback, DISCLOSED in Evidence.
- [ ] N-1 (no orphan): after every leg — close, exit, start-failure, hard-kill+relaunch — zero `restful-doom.exe`; the startup sweep is the backstop.
- [ ] N-2 (bounded times): startup ≤ `DOOM_READY_TIMEOUT_S`, graceful stop ≤ `DOOM_STOP_TIMEOUT_S`, exit hook ≤ `DOOM_EXIT_HOOK_BOUND`, each HTTP request ≤ `DOOM_REQUEST_TIMEOUT_S`; no unbounded wait anywhere.
- [ ] N-3 (no app regression): Mission Monitor, the `terminal` window, `llama-server`, and the PG supervisor exit hooks behave identically; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] N-4 (loopback-only): the engine binds `127.0.0.1` only; no public interface; the webview CSP is unchanged (all engine HTTP is Rust-side).
- [ ] N-5 (frame budget): `doom_frame` polls at `DOOM_FRAME_POLL_MS` (~15 fps); a dropped frame degrades to the last rendered frame and never blocks the UI thread.
- [ ] N-6 (packaging): the installer ships no GPL engine binary and no non-open WAD (~0 installer growth) — static/packaging check against the bundle.
- [ ] N-7 (live-pipeline receipt): F-21 as above (non-zero count + recent `max(ingested_at)` at round start AND after the drive).

**`DoomErrorCode` coverage:** `notConfigured`→F-11/F-19 · `acquireFailed`→F-18 · `spawnFailed`→F-11 · `readyTimeout`→F-13 · `stopTimeout`→F-8 hang leg · `requestFailed`→F-14 · `frameNotReady`→F-4.
