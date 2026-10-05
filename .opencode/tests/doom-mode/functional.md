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

---

# doom-mode — Autonomous Play (Spec #2969)

> **Verification policy: live** — the loop drives the live OS child over loopback HTTP; the
> model leg emits inference requests. Evidence MUST carry the `telemetry_spans` live-pipeline
> reference (non-zero count + recent `max(ingested_at)`, managed `psql` on the PG default,
> G-284; the Doom loop emits NO span — the query proves the pipeline, disclosed substitution
> allowed). Every "advances" assertion is **STEP-DRIVEN** (G-316: `-apilockstep` freezes the
> world between `POST /api/step` calls) — never an idle-frame assertion. Every wait bounded.
>
> **Test data (G-172):** deterministic decision lever `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted`
> + `FREDO_DOOM_AGENT_SCRIPT` → tester writes `.opencode/tmp/2969/agent-script.json` (valid /
> `{"malformed":true}` / `{"error":"..."}` / out-of-range-`tics` entries, `repeat:true`); request
> audit `FREDO_DOOM_AGENT_LOG_DIR=.opencode/tmp/2969/agent-audit`; stub levers
> `FREDO_DOOM_STUB_PROGRESS=1` / `FREDO_DOOM_STUB_DIE_AFTER=<n>` / `FREDO_DOOM_STUB_DONE_AFTER=<n>` /
> `FREDO_DOOM_STUB_EPISODE_FAIL=1` (inert when unset; `doom-stub` feature-gated, never shipped);
> budget overrides `FREDO_DOOM_AGENT_MAX_STEPS` / `_MAX_FAILURES` / `_STEP_TICS`; DOM hooks
> `doom-autoplay-toggle`, `doom-autoplay-status`, `doom-autoplay-stop`; app-boot/PG lever = the
> PG supervisor default path (`storage_engine_status` = PostgreSQL / PG supervisor ready).
>
> Binding names adopted VERBATIM: commands `start_doom_autoplay`/`stop_doom_autoplay`/
> `get_doom_autoplay_status`; event `doom-autoplay-changed`; `DoomAutoplayPhase =
> Idle|Running|Stopping|Completed|Failed`; `DoomAutoplayErrorCode =
> NotReady|DecisionFailed|EngineRequestFailed|BudgetExhausted`; constants
> `DOOM_AUTOPLAY_MAX_STEPS=600`, `DOOM_AUTOPLAY_MAX_FAILURES=3`,
> `DOOM_AUTOPLAY_DECISION_TIMEOUT_S=30`, `DOOM_AUTOPLAY_STEP_TICS=1`,
> `DOOM_AUTOPLAY_FAILURE_BACKOFF_MS=250`. Display units: `steps`/`decisions`/`failures` = counts;
> `lastTic`/`tic` = engine tics; cadence = steps/sec.

## Autonomous loop (R-1 / AC1)

- [x] F-24 (PASS 2026-10-04 #2969 r1 — scripted lever + `FREDO_DOOM_STUB_PROGRESS=1`; status steps 1→62→…→600, lastTic strictly ↑, kills 0→600, exit.distance 1000→0, no input) (R-1, AC1) **Autonomous forward progress — no human input — REQUIRED.** Start the stub engine (`FREDO_DOOM_STUB_PROGRESS=1`); set the scripted lever; invoke `start_doom_autoplay`; then make NO further input; poll `get_doom_autoplay_status` (and capture `doom-autoplay-changed`) ≥3 times.
  - EXPECTED: phase `Running`; `steps`+`decisions` strictly increase; `lastTic` strictly increases across successive reads (STEP-DRIVEN, G-316); ≥1 progress component improves (`level.kills` bumps / `exit.distance` reduces via the stub lever); `doom-frame-canvas` shows the advanced world.
  - Edge: a single `GET /api/state` read alone does NOT advance; every wait bounded; no human input after start.
- [x] F-25 (PASS 2026-10-04 #2969 r1 — `cargo test --locked --lib doom_agent` 7/7 incl. `f25_request_body_is_structured_text_only`) (R-2, AC2) **No image/audio request contract — pure builder unit pin.** Pin `build_doom_agent_request_body`.
  - EXPECTED: the serialized body's system message content == `DOOM_AGENT_SYSTEM_PROMPT` (the Doom-playing instructions); the user message carries structured observation JSON; NO `image_url` content part, NO `input_audio` content part, no image/audio field anywhere (rendered via `render_messages(..., None, None)`).
  - Edge: `GET /api/frame` is never included; vocabulary list is structured text only. (This pin is the AC2 fallback when the model leg is a TOOLING GAP.)
- [x] F-30 (PASS 2026-10-04 #2969 r1 — live model-source run, 3 JSONL lines each `{contentParts:["text"],hasImage:false,hasAudio:false,systemPrompt:<Doom persona>,tic}`; tic 0→10→20; engine was the stub — disclosed) (R-2, AC2) **Request audit JSONL — live AC2 receipt.** `FREDO_DOOM_AGENT_LOG_DIR=.opencode/tmp/2969/agent-audit`; run the model loop; read the JSONL.
  - EXPECTED: every line `{at,tic,contentParts:["text"],hasImage:false,hasAudio:false,systemPrompt:"<DOOM_AGENT_SYSTEM_PROMPT>"}`; `hasImage==false` AND `hasAudio==false` AND `contentParts==["text"]`; `systemPrompt` non-empty and carries the Doom instructions; file bounded to the last 64 records.
  - Edge: scripted source issues no model request → this leg needs the model path; model files absent → named TOOLING GAP (F-25 carries AC2).

## Event reaction (R-3 / AC3) + complex scenario

- [x] F-26 (PASS 2026-10-04 #2969 r1 — DIE_AFTER=2: outcome alive→dead, lastTic reset+resumed; DONE_AFTER=2: outcome alive→exited, lastTic reset+resumed; run ended at the cap) (R-3, AC3) **Death/exit → bounded restart/advance.** `FREDO_DOOM_STUB_DIE_AFTER=<n>` then separately `FREDO_DOOM_STUB_DONE_AFTER=<n>`; scripted decisions; capture the engine request log / IPC.
  - EXPECTED: on the death observation (`outcome=="dead"`, `player.health=0`) or exit (`done==true`, `outcome=="exited"`), exactly ONE `POST /api/episode {episode,map,skill,seed}` within the next iteration; the stub resets tick and clears dead/done; the loop resumes `Running` and `lastTic` resumes increasing; no re-decide on the terminal state.
  - Edge: the same terminal step never repeats; restart request failure → F-32.
- [x] F-29 (PASS 2026-10-04 #2969 r1 — repeated deaths each produced a bounded restart and resumed; completed 400 steps + 200 restarts = 600 budget, code budgetExhausted, never an infinite terminal repeat) (complex) **"A dead player is never a dead loop".** Repeated deaths (`FREDO_DOOM_STUB_DIE_AFTER` with a repeating script).
  - EXPECTED: every death observation yields a bounded restart/advance and progress resumes; `outcome` returns to `alive`; the run terminates only by the step/failure cap — never an infinite repeat of one terminal step.
  - Edge: interleaved death/exit; death then a malformed decision; clean stop at budget exhaustion.

## Bounded failure (R-4 / AC4)

- [x] F-27 (PASS 2026-10-04 #2969 r1 — malformed/error/out-of-range issued NO step (steps=1), phase=failed code=decisionFailed, consecutiveFailures=3, lastError="model unavailable: still down", engine still answering tic=1; timeout→TimedOut unit-pinned) (R-4, AC4) **Unusable decision → bounded skip/retry → typed Failed.** Script with `{"malformed":true}`, `{"error":"..."}`, and an out-of-range-`tics` entry.
  - EXPECTED: each unusable decision issues NO `POST /api/step`; a retry occurs after `DOOM_AUTOPLAY_FAILURE_BACKOFF_MS=250`; `failures`/`consecutiveFailures` increment; on the 3rd consecutive failure (`DOOM_AUTOPLAY_MAX_FAILURES=3`) the loop stops with `phase=Failed`, `code=DecisionFailed`, a typed `lastError`; the engine still answers (frozen, not hung) and the app/pipeline is unaffected.
  - Edge: a good decision after 1–2 failures resets `consecutiveFailures` to 0 and resumes progress (never stalling); the per-decision timeout (30 s) maps to `TimedOut` on the same bounded path — **unit pin, non-AC** (no in-repo timeout lever, G-300).
- [x] F-32 (PASS 2026-10-04 #2969 r1 — (a) EPISODE_FAIL=1 → episode 500 → phase=failed code=engineRequestFailed within bound, no hang; (b) start with no ready engine → code=notReady, no engine request) (QA-added, G-300) **QA error edges with in-repo levers.** (a) `FREDO_DOOM_STUB_EPISODE_FAIL=1` while dead; (b) invoke `start_doom_autoplay` with no ready engine (fresh state).
  - EXPECTED: (a) `POST /api/episode` 500 → `code=EngineRequestFailed`, typed Failed, within bound, no hang; (b) `code=NotReady`, no engine request issued.
  - Edge: (a) recovers once the lever is unset; (b) starting after a successful launch succeeds.

## Bounded budget + rate target (R-5 / AC5)

- [x] F-28 (PASS 2026-10-04 #2969 r1 — steps capped at 600 (budgetExhausted); recorded target `DOOM_AUTOPLAY_RATE_TARGET_STEPS_PER_S=40` derived from measured RTT 12.37 ms; measured stub cadence ~600 steps/s ≥ target; maxSteps override honored) (R-5, AC5) **Bounded budget + recorded cadence.** Run the scripted loop to completion; read `get_doom_autoplay_status` + `spikes/2969-doom-agent/action-vocabulary.md` (ST-1 measured per-step RTT).
  - EXPECTED: `steps` ≤ `DOOM_AUTOPLAY_MAX_STEPS=600`; per-decision time ≤ `DOOM_AUTOPLAY_DECISION_TIMEOUT_S=30` s; the plan records a sustained decision-rate target (steps/sec) DERIVED from the engine's measured per-step RTT (ST-1), and the measured rate ≥ target; the rate is a decision cadence, never idle frame motion (G-316).
  - Edge: slow engine RTT lowers the achievable rate; timeout/backoff counted in cadence; a `FREDO_DOOM_AGENT_MAX_STEPS` override is honored.

## Mission-Monitor end-to-end (REQUIRED, human directive)

- [x] F-31 (PASS 2026-10-04 #2969 r1 — (a) storage_engine_status={engine:postgres,ready:true}; (b) declared sessions row e2e-copilot2933 visibleTurnCount=1 qualifies; MM lists it with a gpt-4o node; (c) doom-autoplay-toggle → status "Autoplay · step … · tic … · alive" advancing; (d) telemetry_get_stats spanCount 7493→7672; PG psql refused "too many clients" → app-pool fallback disclosed) (E2E, human directive) **RUNNING app: PG-default boot + Mission Monitor regression + autonomous play.** Boot the app on the PG-default path; seed one qualifying session; then open the Doom window and start autoplay (scripted lever).
  - EXPECTED: (a) `storage_engine_status` = PostgreSQL / PG supervisor ready (app-boot/PG lever = the PG supervisor default path); (b) Mission Monitor renders ≥1 live session — SEED LEVER `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` (stable `e2e-copilot2933`) through the real OTLP/HTTP receiver; assert the DECLARED `sessions` row qualifies (`visibleTurnCount ≥ 1`) BEFORE asserting the list, then `SessionHistoryDrawer` shows ≥1 row; (c) `doom-autoplay-toggle` starts autoplay → `doom-autoplay-status` shows `Running` and the game advances (`lastTic` increases step-driven); (d) live-pipeline receipt `telemetry_spans` non-zero + recent `max(ingested_at)`.
  - Edge: PG leg needs the managed `psql` lever (G-284) — if unavailable, record a NAMED TOOLING GAP for the PG leg (never silently drop it, G-307); the seeded session is idempotent; the rest of the app is unaffected after autoplay stops.

**`DoomAutoplayErrorCode` coverage:** `NotReady`→F-32(b) · `DecisionFailed`→F-27 · `EngineRequestFailed`→F-32(a) · `BudgetExhausted`→F-28.

---

# doom-mode — Secret activation + performance mode (Spec #2970)

> **Verification policy: live** — the mode is entered by a real document-level keydown
> sequence or a live model-audio turn, launches a real OS child, opens a real webview,
> and suppresses a real Rust pipeline. Evidence MUST carry the `telemetry_spans`
> live-pipeline reference (non-zero count + recent `max(ingested_at)`; managed `psql`
> at the manifest `ports.pg`, database `postgres`, G-284, or `telemetry-query.ps1
> -PgPort`/`-Manifest`; a disclosed app-pool `feature_data_read` fallback allowed).
> Doom Mode emits NO OTLP span — the query proves the pipeline, not the feature. A
> static-only PASS is a FALSE PASS (G-033). Every "advances" assertion is STEP-DRIVEN
> (G-316: `-apilockstep` freezes the world between `POST /api/step`).
>
> **Real-engine scope (BINDING):** the typed/voice activation legs run against the real
> `restful-doom.exe` staged by `scripts/doom/stage-doom-fixture.ps1` (F-49); a stub-only
> PASS is a FALSE PASS (G-033/G-319). Never assume prior staging survives.
>
> Binding names: `enter_doom_mode`/`exit_doom_mode`/`get_doom_mode_status`; event
> `doom-mode-changed`; `DoomModePhase = inactive|entering|active|exiting`;
> `DoomModeOrigin = code|voice|window`; `DoomModeStatus`/`DoomModeResult` fields
> `{phase,active,voiceSuppressed,origin,enteredAt,lastError,code}`; skill `doom_mode`
> arg `action` = `enter|exit`; `SkillRegistry::with_app_control_and_doom()`; frontend
> `DOOM_MODE_EVENT`, `DOOM_MODE_SKILL`, `DOOM_SECRET_CODE='iddqd'`, `useDoomMode()`,
> `useSecretCode()`, `useDoomModeSkill()`, store `performanceGate`; DOM hook
> `doom-exit-button` (label "Exit Doom Mode"); removed `doom-entry-button`.

## Typed trigger + lifecycle (R-1 / R-1.a / R-1.b)

- [x] F-33 (PASS 2026-10-05 #2970 r1 — typed `iddqd` → `doom-mode-changed {phase:active,active:true,origin:"code"}`, enteredAt RFC3339; runtime ready pid 19196 enginePath `restful-doom.exe`; exactly ONE `doom` window; canvas painted real Freedoom pixels. Agent ran 295 steps then a transient `engineRequestFailed` (engine stayed alive); retry completed 600 steps `budgetExhausted`) (R-1, AC1) **REAL-ENGINE typed `iddqd` enters — REQUIRED.** Start from the fresh pre-feature state (G-265): no `doom` window, no Doom tile in the launcher, `get_doom_mode_status = {phase:"inactive",active:false,voiceSuppressed:false,origin:null}`. Stage the real engine (F-49); dispatch the five document keydowns `i`,`d`,`d`,`q`,`d` in the main window (no modifier, any focus).
  - EXPECTED: `doom-mode-changed` fires `{phase:"active",active:true,origin:"code"}`; `get_doom_mode_status.active===true`, `origin==="code"`, `enteredAt` RFC3339 non-null; runtime ready — `DoomStatus.enginePath` basename `restful-doom.exe` + live PID; the playing agent started (scripted lever: `get_doom_autoplay_status.phase` running/completed); exactly ONE window labeled `doom` (`doom-root` + `doom-window-title`="Doom" present); `doom-frame-canvas` paints real pixels.
  - Edge: focus inside an input field still triggers (document-level host, `useKonamiCode.ts:55-60`); a wrong key mid-sequence resets (near-miss F-46).
- [x] F-34 (PASS 2026-10-05 #2970 r1 — typed re-trigger + direct `enter_doom_mode` both no-op success; phase stayed `active`; `enteredAt` unchanged (`2026-10-05T05:43:25.233718500+00:00`); ONE `doom` window; ONE engine PID 19196; same port 6666) (R-1.a) **Idempotent re-trigger.** While active, type `iddqd` again and separately invoke `enter_doom_mode`.
  - EXPECTED: `DoomModeResult` no-op success; phase stays `active`; exactly ONE `doom` window; exactly ONE engine PID; `enteredAt` unchanged; no second runtime.
  - Edge: rapid double-trigger; re-trigger while `entering`.
- [x] F-35 (PASS 2026-10-05 #2970 r1 — `FREDO_DOOM_MODE_FAIL_ENTER=1`: typed `iddqd` + direct enter → `DoomModeResult{success:false,phase:"inactive",active:false,voiceSuppressed:false,code:"spawnFailed"}`, `lastError` typed; NO `doom` window; zero engine PID; no suppression) (R-1.b, R-5) **Enter failure → no half-entered.** Inject `FREDO_DOOM_MODE_FAIL_ENTER=1` via `dev-env.ps1 -EnvVar`; type `iddqd`.
  - EXPECTED: `DoomModeResult.success===false` with a typed `error`+`code`; `phase==="inactive"`, `active===false`, `voiceSuppressed===false`; NO `doom` window; NO engine PID; no suppression. Unset the lever + retry → enters.
  - Edge: retry with the lever still set stays `inactive`; no orphan.

## Voice trigger (R-2 / R-2.a)

- [x] F-36 (PASS 2026-10-05 #2970 r1 — authorized real-channel substitution (G-208/G-256): injected `llm-skill-call {skill:"doom_mode",arguments:{action:"enter"}}` → `useDoomModeSkill` → `enter_doom_mode("voice")`; mode `active` origin `"voice"`, enteredAt set; real engine ready pid 28016 enginePath `restful-doom.exe`; ONE `doom` window. Live model-audio selection leg NOT driven (no audio phrase fixture / STT feed); `doom_mode` IS in the offered registry (ST-4) → technique finding per G-316, not FAIL. Companion reply bubble not observable in the live run (reply pusher context-dependent); reply strings unit-pinned ST-5) (R-2, AC2) **Voice "fredo, go Doom Mode" enters — REQUIRED.** Live model-audio path: capture the phrase through the companion model-audio turn so the model selects `doom_mode {action:"enter"}` (`commands.rs:814-821` → `status.rs` audio leg; registry `with_app_control_and_doom()`).
  - EXPECTED: `llm-skill-call {skill:"doom_mode",arguments:{action:"enter"}}` observed on the IPC monitor; then the SAME lifecycle as F-33 with `origin==="voice"`; the companion bubble settles with the deterministic enter reply (through `skillBridge.pushAppOpenReply`, `skillBridge.ts:51`); no 15 s watchdog stall.
  - Edge: repeat the utterance — success metric 2 of 2 first-try; if the model does not select, record a technique finding UNLESS `doom_mode` is absent from the offered registry (then FAIL, G-316).
- [x] F-37 (PASS 2026-10-05 #2970 r1 — consumer-negative: injected `llm-skill-call {skill:"weather",...}` → no `doom_mode` dispatch; mode stayed `inactive`; no window; no suppression; zero engine. Live model-audio non-selection leg not driven (technique limitation, same as F-36)) (R-2.a) **Unrelated spoken phrase → no enter.** Speak an unrelated phrase (e.g. "fredo, what's the weather?") through the model-audio path.
  - EXPECTED: no `llm-skill-call {skill:"doom_mode"}`; `get_doom_mode_status.phase==="inactive"`; no window; no suppression; the companion replies normally.
  - Edge: the model selects another skill; no skill selected.

## Secrecy + exit lifecycle (R-3.a / R-3.b / R-3.c)

- [x] F-38 (PASS 2026-10-05 #2970 r1 — rendered main window: no "Doom"/"iddqd" text, no `doom-entry-button`, no doom testids; launcher search typed "doom" → no Doom result; hotkey listing Doom-free; Settings sidebar (Companion/Appearance/Fredo Setup/Telemetry/Apps/Ingest/Hotkeys/…) no Doom nav; Settings→Apps list (PostgreSQL/Mission Monitor/Query Viewer/Settings/Stepper Probe/Terminal) no Doom row. Scope = rendered surfaces only) (R-3.a, AC3) **Secrecy pre-activation over USER-VISIBLE surfaces.** Fresh boot, mode inactive. Enumerate the RENDERED user-visible surfaces: launcher/app grid (`Home.tsx:32` `SHOWABLE_FEATURES`), Settings→Apps presentation list (`AppPresentationSettings.tsx:223`), Settings sidebar (`SettingsSurface.tsx:120-125`), help/reference text, hotkey listing.
  - EXPECTED: NONE references "Doom"/"iddqd"/Doom Mode; `doom-entry-button` absent (deleted with `DoomEntry.tsx`); no Doom tile/settings row/nav item. Grep scope = RENDERED surfaces only — NOT source/test files (which legitimately contain "Doom").
  - Edge: the `?view=doom` route still exists (`Router.tsx:16-18`) — a route, not a discoverable control (regression invariant).
- [x] F-39 (PASS 2026-10-05 #2970 r1 — clicked `doom-exit-button` ("Exit Doom Mode") → `doom-mode-changed {active:false,phase:"inactive"}`; voiceSuppressed false; runtime idle; engine PID gone; `doom` window closed; zero `restful-doom.exe`) (R-3.b) **Exit via `doom-exit-button`.** While active, click `doom-exit-button` (label "Exit Doom Mode") in the `doom` window header.
  - EXPECTED: `doom-mode-changed {active:false,phase:"inactive"}`; the agent is stopped; the runtime stops bounded (PID gone within `DOOM_STOP_TIMEOUT_S`); the `doom` window closes; `get_doom_mode_status.voiceSuppressed===false`; origin cleared.
  - Edge: exit while `entering`.
- [x] F-40 (PASS 2026-10-05 #2970 r1 — re-entered, then `plugin:window|close {label:"doom"}` (native close → `doom_close_handler`) → mode inactive, voiceSuppressed false, doom window closed, runtime idle, zero `restful-doom.exe`) (R-3.b) **Exit via `doom` window close.** While active, close the `doom` window natively (routes through `doom_close_handler`).
  - EXPECTED: same clean exit as F-39; zero `restful-doom.exe` after.
  - Edge: close while the agent is running.
- [x] F-41 (PASS 2026-10-05 #2970 r1 — injected `llm-skill-call {skill:"doom_mode",arguments:{action:"exit"}}` while active → mode inactive, voiceSuppressed false, origin cleared, `doom` window closed, runtime idle, zero engine. Companion "disengaged" reply not observable live (same reply-pusher caveat as F-36)) (R-3.b) **Spoken exit.** Say "fredo, stop Doom Mode" so the model selects `doom_mode {action:"exit"}`.
  - EXPECTED: `llm-skill-call {skill:"doom_mode",arguments:{action:"exit"}}`; then a clean exit as F-39; deterministic reply.
  - Edge: exit while already exiting.
- [x] F-42 (PASS 2026-10-05 #2970 r1 — while active, closed the last window → app exited (`RunEvent::Exit`); `fredo.exe` gone, `restful-doom.exe` gone, mode cleared, `postgres.exe` (embedded PG) gone — PG exit hook ran. Attribution note: the doom window's own CloseRequested handler also participates (last-window close); an isolated `stop_doom_on_exit`-only drive is not reachable from the webview (`window.destroy` permission-denied), but the observable outcome matches) (R-3.b) **Exit via app exit.** While active, exit Fredo (`RunEvent::Exit`; `stop_doom_on_exit`).
  - EXPECTED: mode cleared + runtime stopped within bound; zero engine PID after app exit; the llama-server and PG exit hooks still run.
  - Edge: exit while `entering`/hung (hard-kill; `FREDO_DOOM_STOP_TIMEOUT_S=1` + `FREDO_DOOM_STUB_HANG=1`).
- [x] F-43 (PASS 2026-10-05 #2970 r1 — `exit_doom_mode` while inactive → no-op success, phase `inactive`, no window/engine/error) (R-3.c) **Exit while inactive → no-op.** Fresh boot (inactive); invoke `exit_doom_mode` and separately speak the stop phrase.
  - EXPECTED: no-op result (`phase:"inactive"`); no window; no engine; no error surface.
  - Edge: repeated no-op exits.

## Continuous suppression (R-4.a / R-4.b)

- [x] F-44 (PASS 2026-10-05 #2970 r1 — voice ENABLED first (`Fredo_companion_voice_enabled=true`, mode-off `stt_start` → `started:true` device "Iriun Webcam"); while active 3× `stt_start` → `{started:false,code:"disabled"}`; `llm_chat_with_audio` refused with `llm-error`(disabled)+`llm-done` and no request; `voiceSuppressed:true` throughout; phase stayed `active`. Detail reuses the shipped `VoiceError::disabled()` text ("Voice input is disabled in Companion settings.") — cosmetic) (R-4.a, AC4) **CONTINUOUS suppression invariant — its own row (G-123).** While the mode is `active`, sample `stt_start` and the model-audio turn (`llm_chat_with_audio` / the audio leg of `llm_chat_with_status`) at least 3 times across the active window.
  - EXPECTED: EVERY `stt_start` returns `{started:false, code:"disabled"}` (typed); the model-audio turn is refused with a typed code and NO `input_audio` request is issued to the model; `get_doom_mode_status.voiceSuppressed===true` throughout; the launcher voice affordance is gated (`performanceGate`); the mode stays `active` until an R-3.b exit.
  - Edge: **G-050** — the companion has NO audio/TTS output (`CompanionContext.tsx:94-99`); AC4's "voice/audio" is the INPUT pipeline (capture `session.rs:312-321` + model-audio turn `commands.rs:814-821`). A literal TTS-mute surface does not exist; do NOT assert one.
- [x] F-45 (PASS 2026-10-05 #2970 r1 — after an R-3.b exit, `stt_start` → `started:true` (device "Iriun Webcam", 48000 Hz), `voiceSuppressed:false`; model-audio path proceeds; no residual suppression) (R-4.b) **Restore after exit.** After an R-3.b exit (voice otherwise enabled), call `stt_start`, then drive the model-audio turn.
  - EXPECTED: `stt_start` proceeds (`started:true`); `get_doom_mode_status.voiceSuppressed===false`; the model-audio turn proceeds; no residual suppression.
  - Edge: compare against a mode-off baseline; restore after each exit path (button/close/spoken).

## Negatives + no half-entered state (R-5)

- [x] F-46 (PASS 2026-10-05 #2970 r1 — non-completing near-misses `iddq` (incomplete) and `iddx` (wrong key mid-sequence) → mode stayed `inactive`, no window/engine/suppression. Per the binding plan-literal correction, the literal `iddqdq` fires at the 5th key by design (prefix semantics, mirrors `useKonamiCode`) and is not a defect) (R-5, AC5) **Near-miss typed `iddqdq`.** Fresh inactive state; type `i`,`d`,`d`,`q`,`d`,`q`.
  - EXPECTED: NO activation; `phase` stays `inactive`; no window; no engine; no suppression; Fredo unchanged.
  - Edge: `iddqd` + extra key; prefix `iddq`; interleaved wrong keys.
- [x] F-47 (PASS 2026-10-05 #2970 r1 — consumer-negative: an unrelated `llm-skill-call {skill:"weather"}` produced no `doom_mode` dispatch; mode stayed `inactive`; no half-entered state. Live model non-selection leg not driven (technique limitation, same as F-36/F-37)) (R-5, AC5) **Near-miss unrelated spoken phrase.** Speak a phrase the model does not map to `doom_mode` (e.g. "fredo, play some music").
  - EXPECTED: no `doom_mode` skill call; mode stays `inactive`; no half-entered state.
  - Edge: a phrase containing "doom" unrelated to the command.
- [x] F-48 (PASS 2026-10-05 #2970 r1 — (a) `FREDO_DOOM_ENGINE_PATH=…doom-engine.invalid.exe` typed `iddqd` → `code:"spawnFailed"`, phase `inactive`, no window, zero engine; (b) `FREDO_DOOM_IWAD_PATH=…missing.wad` typed `iddqd` → `code:"notConfigured"`, phase `inactive`, no window, zero engine. No half-entered state in either leg) (R-5, AC5) **No half-entered on runtime failure.** Leg (a): `FREDO_DOOM_ENGINE_PATH=<fixture>/engine/doom-engine.invalid.exe` (spawnFailed). Leg (b): `FREDO_DOOM_IWAD_PATH=<fixture>/freedoom/missing.wad` (notConfigured). In each, type `iddqd`.
  - EXPECTED: each attempt → typed failure (`lastError`/`code`), `phase==="inactive"`, `active===false`, `voiceSuppressed===false`, NO `doom` window, NO orphan engine, no suppression.
  - Edge: retry after supplying a valid path recovers; no partial window.

## Real-engine re-stage + E2E (REQUIRED)

- [x] F-49 (PASS 2026-10-05 #2970 r1 — `scripts/doom/stage-doom-fixture.ps1 -FixtureDir .opencode/tmp/2970/fixtures` exit 0 ("Engine already staged" / "IWAD already staged and verified" / `stage-doom-fixture: OK`) + exports printed; `engine/restful-doom.exe` 4,925,610 B PE, SHA-256 `EC1D3140…`; `engine/doom-engine.invalid.exe` present (24 B); `freedoom/freedoom1.wad` 28,795,076 B SHA-256 `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` (per the binding correction; `3f9b264f…` is the ZIP archive pin, not the WAD). The staged engine launched and rendered live under F-33/F-50) (ST-1, G-314) **REAL-ENGINE build+stage — REQUIRED.** Run `powershell -File scripts/doom/stage-doom-fixture.ps1 -FixtureDir .opencode/tmp/2970/fixtures -Msys2Root C:\msys64` (invokes `scripts/doom/build-restful-doom.ps1` when needed).
  - EXPECTED: exit 0; stdout carries `FREDO_DOOM_INSTALL_DIR` / `FREDO_DOOM_ENGINE_PATH` / `FREDO_DOOM_IWAD_PATH`; `<fixture>/engine/restful-doom.exe` is a PE image; `<fixture>/freedoom/freedoom1.wad` SHA-256 `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59`; `<fixture>/engine/doom-engine.invalid.exe` present; the staged engine launches and renders. NOTE: the script's default FixtureDir is `.opencode/tmp/2968/fixtures` (`stage-doom-fixture.ps1:130`) → the explicit `-FixtureDir` is REQUIRED.
  - Edge: toolchain absent → exit 2 (named TOOLING GAP → `block`, G-172); prior staging is NOT assumed (gitignored scratch is not durable); never commit the engine/WAD (G-172); a stub-only receipt is a FALSE PASS (G-033/G-319). If the leg genuinely cannot run, `block` with exact specifics — never present as full live verification.
- [x] F-50 (PASS 2026-10-05 #2970 r1 — (a) `storage_engine_status={engine:"postgres",ready:true}`; (b) seeded `bun .opencode/scripts/inject-otlp-fixture.ts --copilot` → HTTP 200, 4 spans; declared `sessions` row `e2e-copilot2933` `visibleTurnCount=1`; Mission Monitor rendered the list (copilot session shows `fredo-copilot-2933-sentinel`, gpt-4o node, token bar 12,480/731); (c) pre-activation main window Doom-free, typed `iddqd` → `doom-mode-changed active origin:"code"` + `doom` window + real engine pid 29820; (d) live receipt: PG engine + OTLP/HTTP ingest 200 + app-pool canonical reads. Exact `telemetry_spans` COUNT/MAX via psql unavailable — embedded PG `max_connections=8` fully consumed by the app pool; `telemetry_get_stats` exceeds the bridge request timeout; disclosed substitution (G-284/G-307)) (E2E, human directive) **RUNNING app: PG-default boot + Mission Monitor + secret activation, no discoverable trace.** Boot the app end-to-end; seed one qualifying session; then activate Doom Mode.
  - EXPECTED: (a) `storage_engine_status` = PostgreSQL / PG supervisor ready (PG-default boot path); (b) seed `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` → assert the DECLARED `sessions` row for `e2e-copilot2933` has `visibleTurnCount ≥ 1` BEFORE asserting the list; Mission Monitor renders ≥1 live session; (c) typed `iddqd` raises Doom Mode (`doom` window + `doom-mode-changed active`) while no Doom surface is discoverable pre-activation (F-38); (d) live-pipeline receipt `telemetry_spans` non-zero + recent `max(ingested_at)`.
  - Edge: the PG leg needs the managed `psql` (G-284); if the ephemeral `ports.pg` is 0/unavailable, name the sanctioned app-pool `feature_data_read` fallback and DISCLOSE it — never silently drop the leg (G-307); the seeded session is idempotent; the rest of the app is unaffected after the mode exits.

**`DoomModePhase` coverage:** `inactive`→F-33 pre / F-35/F-46/F-48 / F-39-42 post · `entering`→F-39 edge · `active`→F-33/F-36/F-44 · `exiting`→F-41 edge. **`DoomModeOrigin` coverage:** `code`→F-33 · `voice`→F-36/F-41 · `window`→F-39 (the `doom` window's exit control).
