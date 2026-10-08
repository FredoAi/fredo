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

---

# doom-mode — Whole-app Doom theme + armored avatar (Spec #2971)

> **Verification policy: live** — UI-rendering feature: whole-app CSS-variable restyle + an SVG armor overlay.
> Evidence MUST carry the `telemetry_spans` live-pipeline reference (non-zero count + recent `max(ingested_at)`;
> managed `psql` on the PG default, G-284, or a disclosed app-pool `feature_data_read` fallback, G-307).
> **Doom emits NO OTLP span — the query proves the pipeline, not the feature; disclose that.** A static-only PASS
> is a FALSE PASS (G-033).
>
> **Real-engine re-stage (G-319):** live legs need a successful `enter_doom_mode`; gitignored engine/WAD scratch is
> NOT durable across specs — re-stage with
> `powershell -File scripts/doom/stage-doom-fixture.ps1 -FixtureDir .opencode/tmp/2971/fixtures` (no literal
> out-of-repo toolchain arg, G-322; exit 2 = named TOOLING GAP). WAD digest
> `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` (`stage-doom-fixture.ps1:100`), NOT the ZIP
> digest `3f9b264f…` (`:97`) (G-320).
>
> **Stepping (G-316):** `-apilockstep` freezes the world between `POST /api/step`; this slice is phase-driven and
> STATIC per phase — no "advances over time" leg.
>
> Binding names: `DoomPalette`/`DOOM_PALETTE` (`apps/ui/src/app/theme/doomTheme.ts`);
> `setDoomVisualEngaged`/`isDoomVisualEngaged`/`subscribeDoomVisual` (`apps/ui/src/shared/doom-mode/doomVisual.ts`);
> DOM hooks `<html class="doom-mode" data-doom-mode="engaged">`, `<svg data-doom-armor="true">`,
> `<g id="fredo-armor" data-layer="armor">`; engaged = `phase !== 'inactive'` (`types.ts:63-65`); fail-enter lever
> `FREDO_DOOM_MODE_FAIL_ENTER=1` (`mode.rs:29,236-243`).

## Whole-app theme apply/revert (R-1..R-4, R-6)

- [x] F-51 (PASS 2026-10-05 #2971 r1 — real-engine typed `iddqd`; all 23 vars = `DOOM_PALETTE`; `<html class="doom-mode" data-doom-mode="engaged">`; body bg mirrored) (R-1, AC1) **REAL-ENGINE enter → app restyled via the token contract — REQUIRED.** Fresh inactive boot; re-stage the engine (G-319); snapshot `getComputedStyle(document.documentElement)` vars + `document.body` + a card/header; type `iddqd`.
  - EXPECTED: `<html class="doom-mode" data-doom-mode="engaged">`; `--body-bg`/`--card-bg`/`--header-bg`/`--accent-primary`/`--text-primary` change to values EQUAL to `DOOM_PALETTE` fields (equality vs the imported record, not a literal); `document.body.style.background` mirrors the Doom `bodyBg`; card/header repaint. Screenshot saved under `.opencode/tmp/2971/e2e/`.
  - Edge: `entering` phase also restyles; a surface with no direct var read restyles via the contract.
- [x] F-52 (PASS 2026-10-05 #2971 r1 — only `ThemeProvider` imports `DOOM_PALETTE`; zero `--doom-*` vars; surfaces resolve through the existing `--*` contract; COVERAGE assertion, G-271) (R-2, AC1 token-first) **Palette reachable only through the token layer.** Static: grep `DOOM_PALETTE` importers + `--doom-`; live: sample restyled surfaces.
  - EXPECTED: only `ThemeProvider.tsx` imports `DOOM_PALETTE`; zero `--doom-*` vars; restyled surfaces resolve through the pre-existing `--*` contract (`system.ts:56-141`); no component-local hex/rgba; changing only `DOOM_PALETTE` restyles every surface. COVERAGE assertion (G-271) — not a literal var count.
  - Edge: derived `color-mix()` vars re-resolve live.
- [x] F-53 (PASS 2026-10-05 #2971 r1 — `data-doom-armor="true"` + `#fredo-armor` (13 paths, 0 rects); base 58 rects unchanged; both absent on exit; visibly distinct) (R-3, AC2) **Armor overlay present + visibly distinct; absent when inactive.** Enter; snapshot the avatar SVG + screenshot; exit; re-snapshot.
  - EXPECTED: `svg[data-doom-armor="true"]` + `<g id="fredo-armor" data-layer="armor">` rendered AFTER the expression overlay; dense/full-frame pixel diff shows the armored avatar distinct (G-213); base `<rect>` count unchanged and `FREDO_AVATAR_STATES.length` unchanged (frozen 12); on exit both hooks ABSENT.
  - Edge: armor composes with a non-idle state (e.g. `error`) without mutating the vocabulary; armor is NOT a 13th state.
- [x] F-54 (PASS 2026-10-05 #2971 r1 — byte-equal on all vars + body + avatar outerHTML + localStorage; setters never called) (R-4, AC3) **Exit → byte-exact revert; NO persisted-setting mutation.** Snapshot all inline `--*` vars + `document.body` + avatar outerHTML + `localStorage` theme keys before enter; enter; exit; re-snapshot.
  - EXPECTED: byte-equal on every field; `Fredo_theme_overrides`/`Fredo_theme_preset`/`Fredo_user_presets` unchanged (`ThemeProvider.tsx:166,173,179`); `setOverride`/`setPreset`/`resetTheme` NEVER called (`:388-420`) — spy-verified; no flash of default.
  - Edge: exit via `doom-exit-button`, `doom` window close, app exit, spoken exit — all identical.
- [x] F-56 (PASS 2026-10-05 #2971 r1 — preset `dark` + accent `#ff2fd0` + text `#d0ff2f` + card `#101820`; Doom wins engaged; byte-exact restore on exit) (R-6, AC5) **Non-default preset + overrides + accent restored exactly.** Set preset + ≥1 override + distinct accent; snapshot resolved palette; enter; exit; re-snapshot.
  - EXPECTED: preset id, every override key/value, resolved `--accent-primary`/`--accent-contrast` restored EXACTLY — never the stock default; while engaged Doom WINS over the lower layers.
  - Edge: `--accent-contrast` recomputed from the Doom accent while engaged (`ThemeProvider.tsx:380-385`) then restored.

## Secrecy + continuity + error path (R-5, R-7, R-8)

- [x] F-55 (PASS 2026-10-05 #2971 r1 — 18 presets, no Doom; no Doom nav; launcher search "doom" → no match; no Doom token applied; avatar unarmored) (R-5, AC4 negative) **Mode OFF → Doom invisible everywhere.** Fresh inactive boot; enumerate `ThemePresetSelector` options, `SettingsSurface` nav, launcher grid/search, hotkey listing; sample vars + avatar.
  - EXPECTED: `allPresets` has NO Doom entry; selector lists no "Doom" option (`ThemingSettings.tsx:82-99`); no Doom nav item (`SettingsSurface.tsx:163-173`); no `doom-mode`/`data-doom-mode`; no `--*` var carries a `DOOM_PALETTE` value; avatar unarmored.
  - Edge: launcher search "doom" → no result; scope = RENDERED surfaces only; `?view=doom` route remains (regression invariant).
- [x] F-57 (PASS 2026-10-05 #2971 r1 — 5/5 samples across 3 forced re-renders stayed engaged; opening MM while engaged left the main window engaged; module-scoped store) (R-7, G-123 continuous) **Persistence across mount/unmount + re-renders.** While engaged, remount the avatar consumer and/or reopen a window; force ≥2 re-renders.
  - EXPECTED: restyle + armor remain applied across every mount/unmount/re-render (module-scoped `doomVisual.ts`, never a `useRef`); removed only at `inactive`.
  - Edge: window remount during active; re-render never flashes unarmored/unstyled.
- [x] F-58 (PASS 2026-10-05 #2971 r1 — `FREDO_DOOM_MODE_FAIL_ENTER=1` → `code:"spawnFailed"`, phase inactive, byte-equal pre/post, no doom window; lever unset → enters) (R-8, G-275 error path) **Failed enter → no residual Doom theme/armor.** Inject `FREDO_DOOM_MODE_FAIL_ENTER=1` via `dev-env.ps1 -EnvVar`; type `iddqd`.
  - EXPECTED: `DoomModeResult{success:false,phase:"inactive",active:false,code:…}`; no `doom-mode`/`data-doom-mode`; all `--*` vars byte-equal the pre-attempt snapshot; avatar unarmored. Unset + retry → enters.
  - Edge: lever exists (Slice 3, `mode.rs:236-243`); retry with lever still set stays `inactive`; no orphan.

## Engine-free unit pins (G-172) + live receipt + E2E

- [x] F-60 (PASS 2026-10-05 #2971 r1 — `cargo` unit pins green; store idempotency; no-leak; 58-rect pin with armor OFF) (unit, engine-free) **Store + palette + armor pins.** Drive `setDoomVisualEngaged(true|false)`; render `ThemeProvider`; assert `--body-bg`/`--accent-primary`/`--accent-contrast` before→engaged→after; store idempotency; `DOOM_PALETTE` not in `allPresets`; armor presence/absence + 58-rect pin with armor OFF; the R-8 fail-enter revert.
  - EXPECTED: all pins pass with NO engine; store notifies only on change; no leak into `allPresets`.
  - Edge: `setDoomVisualEngaged` called twice with the same value → no notify.
- [x] F-59 (PASS 2026-10-05 #2971 r1 — PG ready; OTLP seed HTTP 200; declared `sessions` row `e2e-copilot2933` visibleTurnCount=1; MM renders; enter themed+armored; exit exact revert) (E2E, human directive) **RUNNING app: PG-default boot + Mission Monitor + Doom theming enter/exit.** Boot end-to-end; seed one qualifying session; enter; exit.
  - EXPECTED: (a) `storage_engine_status` = PostgreSQL / PG supervisor ready; (b) `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` → assert the DECLARED `sessions` row `e2e-copilot2933` qualifies (`visibleTurnCount ≥ 1`) BEFORE asserting the list (`useSessionHistory.ts:46-54`; `MissionMonitorPanel.tsx:872`; drawer `:1170`), then ≥1 row; (c) enter → themed + armored; exit → exact revert, rest of app unaffected.
  - Edge: seed idempotent; PG leg needs managed `psql` (G-284) — else name a disclosed app-pool fallback (G-307); after exit the app is unaffected.
- [x] F-61 (PASS 2026-10-05 #2971 r1 — managed `psql` "too many clients" ×2 → disclosed app-pool fallback: OTLP 200 + canonical `sessions` row + continuous ingest log; Doom emits no span) (live receipt) **Live-pipeline check.** Query `telemetry_spans` at round start AND after the drive.
  - EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. **Doom emits NO span** — the query proves the pipeline, not the feature; disclose.
  - Edge: managed `psql` "too many clients" → disclosed app-pool fallback (G-307), named.

**R-coverage:** R-1→F-51 · R-2→F-52 · R-3→F-53 · R-4→F-54 · R-5→F-55 · R-6→F-56 · R-7→F-57 · R-8→F-58.

---

# doom-mode — Companion resume across sessions (Spec #2972)

> **Verification policy: live** — the resume point is persisted by the Rust agent loop into the
> dedicated PostgreSQL feature table `feature_doom_save` (Spec #3011) and read back after a REAL app
> restart; every level transition is driven by live engine HTTP. Evidence MUST carry the
> `telemetry_spans` live-pipeline reference (NON-ZERO count + recent `max(ingested_at)`) at round
> start AND after the drive. **Doom emits NO OTLP span — the query proves the LIVE PIPELINE, not the
> feature; disclose that.** PG reads use the app-pool command `application_store_query`
> (`{applicationId:'doom', tableName:'save'}`; G-284/G-307) — `psql` is pool-saturated/unreachable and
> MUST NOT be named; `application_data_read` is NOT usable here (the save table is materialized by
> `ensure_table_on_pg`, not declared in the application-data registry). A static-only PASS is a FALSE PASS.
>
> **Evidence split (BINDING):** the REAL `restful-doom.exe` proves R-1/R-2/R-4/R-5. R-3's
> advance→next-level→persist→complete chain is proven on the deterministic stub
> `FREDO_DOOM_STUB_DONE_AFTER=<n>` (`bin/doom_stub.rs:36,335-337`) driving the REAL product loop
> (`agent.rs:299`) + progress writer + `ApplicationStore`. Disclose the split; never present a
> stub-only leg as full live verification.
>
> **Real-engine re-stage (G-319/G-323):** `powershell -File scripts/doom/stage-doom-fixture.ps1
> -FixtureDir .opencode/tmp/3011/fixtures` (no literal out-of-repo toolchain arg, G-322; exit 2 =
> named TOOLING GAP); readiness gate = `get_doom_status.phase="ready"` + one `GET /api/state` 200; if
> the staged copy is not ready, drive the app DEFAULT install dir
> `%APPDATA%\com.fredo.app\doom\engine\restful-doom.exe` and DISCLOSE the substitution; WAD digest
> `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` (`stage-doom-fixture.ps1:100`),
> NOT the ZIP digest `3f9b264f…` (G-320).
>
> **Save-induction levers (G-275/G-300, Spec #3011 — replaces `FREDO_DOOM_SAVE_FILE`):**
> `FREDO_DOOM_SAVE_STATE_DIR=<dir under .opencode/tmp/3011/>` (inert when unset; default
> `.opencode/tmp/3011/doom-save`) with a `<dir>/doom-save.json` fixture — valid `DoomSave` (resume),
> `not json` (corrupt), missing file (absent), a directory at the file path or a missing parent
> (unwritable write). `FREDO_DOOM_SAVE_FORCE_FAIL=read|write` injects a PG-path fault (read→no-save;
> write→Err with NO PG write). Both INERT when unset/blank/unknown. Engine error on resume =
> `FREDO_DOOM_STUB_EPISODE_FAIL=1`.
> **Stepping (G-316):** every "advances" assertion is STEP-DRIVEN. Bounded waits (G-263).
>
> Binding names VERBATIM (G-187, updated #3011): commands `get_doom_save`/`reset_doom_save`/
> `start_doom_autoplay(app, maxSteps?, freshStart?)`; event `doom-autoplay-changed`; wire
> `DoomSaveStatus.{hasSave,episode,map,skill,seed,completed,updatedAt}`; `DoomAutoplayStatus` added
> `{episode,map,completed}`; `DoomAutoplayErrorCode` added `"campaignComplete"`; PG feature table
> `feature_doom_save` (app `doom`, table `save`), record key `DOOM_SAVE_ROW_ID="singleton"`, TYPED
> columns `{id PK, version, episode, map, skill, seed, completed, updated_at}`; constants
> `DOOM_SAVE_VERSION=1`, `DOOM_SAVE_FEATURE_ID="doom"`, `DOOM_SAVE_TABLE_NAME="save"`,
> `DOOM_SAVE_STATE_DIR_ENV="FREDO_DOOM_SAVE_STATE_DIR"`,
> `DOOM_SAVE_FORCE_FAIL_ENV="FREDO_DOOM_SAVE_FORCE_FAIL"`, `DOOM_CAMPAIGN_FIRST_EPISODE=1`,
> `DOOM_CAMPAIGN_LAST_EPISODE=4`, `DOOM_CAMPAIGN_FIRST_MAP=1`, `DOOM_CAMPAIGN_LAST_MAP=9`,
> `DOOM_DEFAULT_SKILL=3`, `DOOM_DEFAULT_SEED=0`; **REMOVED:** `DOOM_SAVE_KEY="doom_save_v1"`,
> `DOOM_SAVE_FILE_ENV="FREDO_DOOM_SAVE_FILE"`, file primitives `seam_path`/`load_at_path`/`store_at_path`;
> testids `doom-save-status`, `doom-fresh-start-button`, `doom-fresh-start-confirm`, `doom-progress-complete`.

## Resume positioning + cross-restart durability (R-1 / R-2 — updated #3011)

- [ ] F-62 (R-1, AC1) **REAL-ENGINE resume positioning via the test-only state-dir lever — REQUIRED.** Write `.opencode/tmp/3011/doom-save/doom-save.json` = `{"version":1,"episode":1,"map":2,"skill":3,"seed":0,"completed":false,"updatedAt":"<now>"}`; launch the app with `FREDO_DOOM_SAVE_STATE_DIR` = `.opencode/tmp/3011/doom-save`; re-stage the real engine (G-319; readiness gate `get_doom_status.phase="ready"` + `GET /api/state` 200); `enter_doom_mode` (resume default). Capture the engine request log / IPC monitor + `GET /api/state`.
  - EXPECTED: exactly ONE `POST /api/episode {episode:1,map:2,skill:3,seed:0}` (`client.rs:364` `restart_with`) BEFORE the first `POST /api/step`; engine `/api/state` reports `level.episode=1`, `level.map=2`; the companion then steps forward (`steps`/`lastTic` strictly increase, STEP-DRIVEN, G-316); `get_doom_save` → `{hasSave:true, episode:1, map:2, skill:3, seed:0}`; `doom-save-status` renders the `E1M2` display unit.
  - Edge: resume via the mode/toggle default AND via `start_doom_autoplay({})` (absent `freshStart`); an E4M9 boundary save; `skill`/`seed` preserved verbatim; entering with no ready engine still resumes on the next start.
- [ ] F-63 (R-2, AC2 — updated #3011) **REAL-ENGINE cross-restart durability via `feature_doom_save` — REQUIRED.** With `FREDO_DOOM_SAVE_STATE_DIR` UNSET (production path), continue F-62 until the campaign advances (a new `DoomSave` written to the PG feature table); confirm the engine PID is gone and fully close Fredo (`RunEvent::Exit`); relaunch; re-enter Doom Mode.
  - EXPECTED: the resume point is read from DURABLE PG storage — the `feature_doom_save` singleton row (`application_store_query({applicationId:'doom',tableName:'save'})` returns exactly ONE row, `id='singleton'`, TYPED columns), NOT process memory and NOT the control plane; after restart `get_doom_save` reports the SAVED coords BEFORE any step; the engine is positioned there by exactly one `POST /api/episode`; the companion keeps progressing; `get_control_setting('doom_save_v1')` → null.
  - Edge: restart with no prior advance (idempotent); restart after a `completed:true` run; clean exit vs hard-kill (durable either way — PG WAL/checkpoint).

## Advance → persist → complete (R-3, deterministic stub — updated #3011)

- [ ] F-64 (R-3, AC3) **Advance→next-level→persist→complete — deterministic stub over the REAL loop; ONE row / no append — REQUIRED.** Stub with `FREDO_DOOM_STUB_DONE_AFTER=<n>` + `FREDO_DOOM_STUB_PROGRESS=1` on the production PG path (`FREDO_DOOM_SAVE_STATE_DIR` unset); observe a level exit → advance → persist; read `feature_doom_save` after EACH transition.
  - EXPECTED: on `done==true && outcome != "dead"` (`is_terminal`, `agent.rs:163-170`; handling `:384-388,415-416`) the campaign advances (map+1; episode+1/map=1 on wrap); the progress writer UPSERTS the singleton row at the NEW coords (`updated_at` advances); **the row count stays exactly ONE (`id='singleton'`) across every transition — no append, no duplicate (#3011 AC4)**; the loop continues at the next level (one `POST /api/episode` at the advanced coords); at the final level (E4M9) `completed:true` persisted, status `phase=completed`, `code="campaignComplete"`, `doom-progress-complete` renders.
  - Edge: death (`outcome=="dead"`, `player.health=0`) restarts the SAME level — never advances/persists; wrap E1M9→E2M1; exactly ONE restart per terminal observation (`agent.rs:345-370`). **DISCLOSE: stub-driven chain over the real loop/writer/`ApplicationStore` — not a real-engine level-exit.**

## Absent/corrupt save + fresh start (R-4 / R-5 — updated #3011)

- [ ] F-65 (R-4, AC4 — updated #3011) **Absent/corrupt/out-of-contract save → clean run, no crash.** (a) `FREDO_DOOM_SAVE_STATE_DIR` → a dir with a MISSING `doom-save.json`; (b) → a dir whose `doom-save.json` contains `not json`; (c) `FREDO_DOOM_SAVE_FORCE_FAIL=read` on the PG path; (d) unit pins: `DoomSave::parse`/`from_row` rejects unknown `version`, `episode∉1..=4`, `map∉1..=9`, `skill∉0..=4` → `None`. Enter Doom Mode for (a)/(b)/(c).
  - EXPECTED: no crash/panic, no blocking; a clean run starts at E1M1 / `DOOM_DEFAULT_SKILL=3` / `DOOM_DEFAULT_SEED=0`; `get_doom_save` → `{hasSave:false, episode:null, map:null, skill:null, seed:null, completed:false, updatedAt:null}`; the mode enters and the companion progresses; console clean.
  - Edge: empty file; whitespace-only; valid JSON wrong shape; unknown `version`; a directory at the state-dir file path. Levers NAMED: missing file / `not json` file under `FREDO_DOOM_SAVE_STATE_DIR`, `FREDO_DOOM_SAVE_FORCE_FAIL=read`.
- [ ] F-66 (R-5, AC5 — updated #3011) **Fresh start does not silently destroy a save; resume never silently starts fresh.** With a VALID save present (PG row OR state-dir fixture): (a) `start_doom_autoplay({freshStart:true})` starts E1M1 and does NOT persist the initial position until the run advances — abort before any level transition leaves the prior save intact; (b) `start_doom_autoplay({})` and `enter_doom_mode` resume at the saved coords; (c) `doom-fresh-start-button` → `doom-fresh-start-confirm` drives the explicit fresh path.
  - EXPECTED: (a) fresh run begins at E1M1; before the first advance `get_doom_save` still reports the PRIOR save UNCHANGED (the `feature_doom_save` singleton row byte-equal via `application_store_query`, or the state-dir fixture byte-equal); after the fresh run advances the row is overwritten with the new coords; (b) absent `freshStart` ⇒ exactly one `POST /api/episode` at the saved coords, never E1M1; (c) the confirm is required before the fresh start proceeds.
  - Edge: abort a fresh run immediately (window close) → prior save intact; confirm dismissed → no fresh start; fresh run from a `completed:true` save; `reset_doom_save` (contract, non-AC) DELETES the singleton row, returns `hasSave:false`, and a subsequent enter starts clean.

## Continuous progress (G-123) + error paths (G-275/G-300 — updated #3011)

- [ ] F-67 (G-123 continuous — updated #3011) **Persisted resume point tracks progress WHILE active; ONE row / no append.** Stub `FREDO_DOOM_STUB_DONE_AFTER=<n>` driving ≥2 transitions on the production PG path; sample `get_doom_save` AND `application_store_query` at ≥3 points across the run (STEP-DRIVEN, G-316).
  - EXPECTED: EVERY level transition UPSERTS exactly ONE row (`updated_at` advances; coords track the campaign); the row COUNT stays exactly ONE (`id='singleton'`) — no append log, no duplicate; the persisted point after a clean stop equals the last reached level; the write is best-effort and never fails the run.
  - Edge: rapid consecutive transitions; stop mid-transition; a store write failure (F-68) does NOT stop the loop; restart mid-run resumes at the last persisted level.
- [ ] F-68 (G-275/G-300 error paths — updated #3011) **Every error-path edge names its in-repo lever.** (a) engine error on resume: `FREDO_DOOM_STUB_EPISODE_FAIL=1` → `POST /api/episode` 500; (b) save READ failure: `FREDO_DOOM_SAVE_FORCE_FAIL=read` (PG path) / corrupt state-dir fixture (F-65b); (c) save WRITE failure: `FREDO_DOOM_SAVE_FORCE_FAIL=write` (PG path, no write) / a directory at the state-dir file path.
  - EXPECTED: (a) typed `EngineRequestFailed` Failed within bound, no hang (reuses the F-32 lever); (b) clean run at initial (R-4); (c) the run CONTINUES — the write failure is logged and ignored (best-effort), `doom-autoplay-changed` keeps advancing, the in-memory campaign progresses, and `FREDO_DOOM_SAVE_FORCE_FAIL=write` produces NO PG write (row unchanged).
  - Edge: unset the lever + retry recovers; write failure then success; engine error on a fresh-start resume. Levers NAMED: `FREDO_DOOM_STUB_EPISODE_FAIL=1`, `FREDO_DOOM_SAVE_FORCE_FAIL=read|write`, corrupt/unwritable `FREDO_DOOM_SAVE_STATE_DIR` fixture.

## Live receipt + E2E (REQUIRED, human directive)

- [ ] F-70 (live receipt — updated #3011) Query `telemetry_spans` at round start AND after the drive.
  - EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. **Doom emits NO span** — the query proves the pipeline, not the feature; disclose. The sanctioned span-producing lever is an OTLP-ingested app action (`bun .opencode/scripts/inject-otlp-fixture.ts --copilot` → real OTLP/HTTP receiver `:4318`), never the `fredo emit` CLI path (G-256).
  - Edge: the app-pool read (`application_store_query` / `telemetry_get_stats`) is the named PG lever (G-284/G-307); `psql` is pool-saturated/unreachable — name NO `psql` substitution.
- [ ] F-69 (E2E, human directive — updated #3011) **RUNNING app: PG-default boot + Mission Monitor + save/resume across a FULL restart via `feature_doom_save`.** Boot the app end-to-end; seed one qualifying session; assert Mission Monitor; then enter Doom Mode with a valid save, assert resume, exit, FULLY restart the app, re-enter, assert the save survived and resumes (the #3011 E2E gate; F-MM3011 is the explicit restart procedure).
  - EXPECTED: (a) `storage_engine_status` = `postgres` / PG supervisor ready; (b) Mission Monitor renders ≥1 live session — assert the DECLARED `sessions` row `e2e-copilot2933` has `visibleTurnCount ≥ 1` BEFORE asserting the list (`useSessionHistory.ts:46-54`; `MissionMonitorPanel.tsx:872`; drawer `:1170`); (c) the save/resume across the app restart works via the PG feature store (`feature_doom_save` singleton row read by `application_store_query`, F-63); (d) live-pipeline receipt `telemetry_spans` non-zero + recent `max(ingested_at)`.
  - Edge: the PG read uses the app-pool `application_store_query` (G-284/G-307); `psql` is pool-saturated/unreachable — NEVER name it; the seeded session is idempotent; the rest of the app is unaffected after the Doom exit.

**R-coverage (#2972 / updated #3011):** R-1→F-62 · R-2→F-63 · R-3→F-64 · R-4→F-65 · R-5→F-66 · G-123→F-67 · G-275/G-300→F-68 · live receipt→F-70 · E2E→F-69.

---

# doom-mode — Doom save in a dedicated PostgreSQL feature store (Spec #3011)

> **Verification policy: LIVE** — PG round-trip + full-app restart survival + Mission Monitor rendering
> are observed on the RUNNING app. Evidence MUST carry the `telemetry_spans` live-pipeline reference
> (NON-ZERO count + recent `max(ingested_at)`) at round start AND after the drive. **Doom emits NO OTLP
> span — the query proves the LIVE PIPELINE, not the feature; disclose that.** A static-only PASS is a
> FALSE PASS (G-033). All waits bounded (G-263).
>
> **BINDING names (Architect G-255):** feature table `feature_doom_save` (app `doom`, table `save`);
> record key `DOOM_SAVE_ROW_ID="singleton"`; TYPED columns `{id PK, version, episode, map, skill, seed,
> completed, updated_at}`; atomic write = `INSERT … ON CONFLICT(id) DO UPDATE` (never delete-then-insert);
> `clear` deletes the singleton row (the ONLY delete). Removed: `FREDO_DOOM_SAVE_FILE`, `DOOM_SAVE_KEY`
> (`doom_save_v1`), file primitives.
>
> **PG read lever (G-284/G-307):** the app-pool command `application_store_query`
> (`lib.rs:947`, `application_store.rs:850`) invoked `{applicationId:'doom', tableName:'save'}`.
> Do NOT name `psql` (pool-saturated/unreachable). Do NOT use `application_data_read` for this table
> (undeclared in the application-data registry → hard error).
>
> **Induction levers (G-275/G-300/G-316):** `FREDO_DOOM_SAVE_STATE_DIR` (default `.opencode/tmp/3011/doom-save`)
> + `FREDO_DOOM_SAVE_FORCE_FAIL=read|write`; both inert when unset/blank/unknown.
>
> **Real engine (G-319/G-323):** `scripts/doom/stage-doom-fixture.ps1 -FixtureDir .opencode/tmp/3011/fixtures`;
> readiness gate = `get_doom_status.phase="ready"` + `GET /api/state` 200; default-install-dir fallback disclosed.

## PG round-trip, restart survival, no control plane (R-1 / R-2)

- [ ] F-71 (R-1, AC1) **PG round-trip + restart survival + exactly one `POST /api/episode` before the first step — REQUIRED.** On the production PG path (no state-dir env): drive a real level transition (or the scripted stub advance) so a `DoomSave` is written; `application_store_query({applicationId:'doom',tableName:'save'})`; fully stop the app; relaunch; re-enter Doom Mode.
  - EXPECTED: exactly ONE row `id='singleton'` with columns `{version, episode, map, skill, seed, completed, updated_at}`; equal to the last written coords; after restart `get_doom_save` reports those coords BEFORE any step; exactly ONE `POST /api/episode` at those coords before the first `POST /api/step`; `updated_at` advances on each level transition.
  - Edge: E4M9 boundary save; restart with no prior advance; clean exit vs hard-kill; `skill`/`seed` preserved verbatim.
- [ ] F-72 (R-2, AC2) **No control-plane read/write of the save path; corrupt-safe — REQUIRED.** (a) call `get_doom_save`; (b) `get_control_setting('doom_save_v1')`; (c) capture the IPC monitor across a save/resume; (d) corrupt/absent/out-of-contract fixtures.
  - EXPECTED: (a) `get_doom_save` reads ONLY `feature_doom_save`; (b) `get_control_setting('doom_save_v1')` → null; (c) the IPC monitor shows NO control-plane read/write of the save key (only `application_store_query`/upsert on `doom`/`save`); (d) corrupt/absent/out-of-contract → `get_doom_save` `{hasSave:false, episode:null, map:null, skill:null, seed:null, completed:false, updatedAt:null}` and a clean run E1M1 / skill 3 / seed 0, no crash.
  - Edge: absent row; `not json`; unknown `version`; `episode∉1..=4`; `map∉1..=9`; `skill∉0..=4`; a directory at the state-dir file path; blank env. NOTE: non-save Doom keys (`doom_port`, `doom_last_error*`, `doom_pid`) legitimately remain in the control plane (ST-2 non-goals) — do NOT assert "no Doom key at all".

## Seam removed + documented induction (R-3)

- [ ] F-73 (R-3, AC3) **Removed seam; documented in-repo test-only induction (both legs) — REQUIRED.** Static: grep product code (`apps/tauri/src-tauri/src/**`, `apps/ui/src/**`) for `FREDO_DOOM_SAVE_FILE`, `DOOM_SAVE_KEY`, `doom_save_v1`, `seam_path`, `load_at_path`, `store_at_path`. Live: (a) `FREDO_DOOM_SAVE_STATE_DIR` valid fixture → resume; corrupt fixture → clean run; a DIRECTORY at the file path → write fails logged, run continues; (b) `FREDO_DOOM_SAVE_FORCE_FAIL=read` → no-save; `=write` → `store` returns `Err` with NO PG write, run continues.
  - EXPECTED: the removed symbols are ABSENT from product code (docs are SI/human doc-sync, out of the dev's scope); the state-dir fixtures drive load/store/clear as documented; `FORCE_FAIL` is inert when unset/blank/unknown; the PG row is unchanged by a forced write failure.
  - Edge: unset; blank; unknown FORCE_FAIL value; missing parent dir; forced failure then a normal success.

## Atomic repeated cycles, last save not lost (R-4)

- [ ] F-74 (R-4, AC4) **Atomic repeated cycles; ONE row / no append; last durable save survives close — REQUIRED.** Drive ≥2 level transitions (stub `FREDO_DOOM_STUB_DONE_AFTER=<n>`); read `feature_doom_save` after each; source-pin `ApplicationStore::upsert` (`application_store.rs:344-430`); close the app after a durable save; restart.
  - EXPECTED: source PIN — `upsert` emits `INSERT … ON CONFLICT(id) DO UPDATE`; the save cycle contains NO `delete`+`insert`; the row count stays exactly ONE (`id='singleton'`), no duplicate/partial; `updated_at` strictly advances; the last durable save is read on the next start.
  - Edge: rapid consecutive transitions; stop mid-transition; a failed write does not stop the loop; `reset_doom_save` delete is the only delete path.

## Mission-Monitor end-to-end (REQUIRED — human directive)

- [ ] F-MM3011 (E2E, human directive) **RUNNING app: PG-only boot + Mission Monitor live sessions + Doom save/resume survives a FULL app restart via `feature_doom_save`.** Procedure: (1) boot end-to-end (PG-default); (2) `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-exchange.fixture.json` → real OTLP/HTTP receiver `:4318/v1/traces`; guard the DECLARED `sessions` row `e2e-copilot2933` has `visibleTurnCount ≥ 1` BEFORE asserting the list; (3) drive the Doom loop (real engine if ready, else the disclosed default-install-dir fallback) so a `DoomSave` is written; (4) `application_store_query({applicationId:'doom',tableName:'save'})` → exactly ONE `id='singleton'` row; (5) fully QUIT the app (last-window close → `RunEvent::Exit`, PG exit hook) and relaunch; (6) re-enter Doom Mode.
  - EXPECTED PG OBSERVABLE: one `feature_doom_save` row `id='singleton'` with the typed columns at the saved coords; `get_control_setting('doom_save_v1')` → null. (a) `storage_engine_status` = `{engine:"postgres", ready:true}`; (b) Mission Monitor renders ≥1 `.mm-session-row`; (c) after the FULL restart, `get_doom_save` reports the SAVED coords BEFORE any step and exactly ONE `POST /api/episode` positions the engine there before the first `POST /api/step`; (d) `telemetry_spans` non-zero + recent `max(ingested_at)`.
  - Edge: `psql` unavailable → the app-pool `application_store_query` is the named lever (G-284/G-307), NEVER `psql`; the seeded session is idempotent; the rest of the app is unaffected after the Doom exit.

## Non-functional (N-1..N-5)

- [ ] N-1: `cargo check --locked` ZERO warnings (no `#[allow(...)]`); `pnpm --filter @fredo/ui build` green (frontend untouched).
- [ ] N-2: every save/load bounded by the pool acquire timeout; a save failure is logged and never fails/stops the run.
- [ ] N-3: no `AppStore` cached read/write on the save path; existing non-save Doom control-plane keys untouched.
- [ ] N-4: `feature_doom_save` materialized pre-install via `register_pg_schema_init` (fail-closed), mirroring Terminal.
- [ ] N-5: console clean of `Error:` / `Uncaught` / `Maximum update depth exceeded` across every leg; Mission Monitor/terminal/PG exit hooks unchanged.

**R-coverage (#3011):** R-1→F-71 · R-2→F-72 · R-3→F-73 · R-4→F-74 · live receipt→F-70 · E2E→F-69/F-MM3011 · N-1..N-5.
