# doom-mode — Exploratory Test Cases (Spec #2968)

> Unscripted edge/failure probes for the Doom window/runtime slice. The Tester adds probes here as they work; a confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).
>
> **Verification policy: live** — probes are driven against the running artifact; record DOM/screenshot/process receipts and the `telemetry_spans` live-pipeline reference (managed `psql` on the PG default, G-284, or a disclosed `telemetry_get_stats` substitution). A static-only observation is not a finding.
>
> **G-300:** any error/failure probe added here must name an in-repo induction lever (env override under `.opencode/tmp/2968/`, or a static/unit pin marked non-AC) — no lever-less error edge.
>
> **Real-engine scope:** probes that exercise the live game use the REAL `restful-doom.exe` (ST-2); the stub is only a lever for error-path pins.

## Prompt lines

- [ ] E-1: Rapid open/close/open during the `starting` phase — does a stale window or a second real engine accumulate? (Lever: STUB + poll PIDs.)
- [ ] E-2: Close the window exactly while `doom_step` is in flight — does the request fail cleanly (`requestFailed`) with no panic and no orphan?
- [ ] E-3: `doom_frame` while the engine is hung (`FREDO_DOOM_STUB_HANG=1`) — does the bounded request timeout fire and the UI degrade to the last rendered frame rather than block?
- [ ] E-4: Hard-kill Fredo mid-`ready`, then relaunch — does the startup sweep reclaim the orphan and never kill an unrelated reused PID?
- [ ] E-5: Two simultaneous `doom_read_state` calls — is the round trip still single-request each, with no interleaving corruption?
- [ ] E-6: Open the `doom` window, then open it from a second entry path — still exactly one window/engine?
- [ ] E-7 (SUPERSEDED by #3013 — the engine runtime-download acquisition leg is REMOVED; there is no engine archive URL anymore. Kept for history; see F-92.): Reachable-but-mismatched engine-archive seam — is the failure typed `acquireFailed` and fail-closed (no partial staged binary used)?
- [ ] E-8: Boot with a stale `doom_install_dir` PID marker whose PID now belongs to an unrelated process — the image guard must refuse to kill it.
- [ ] E-9: Theme/light-dark on the error state and status readout — theme tokens only, no hardcoded hex.
- [ ] E-10: The `doom` window is open when the app exits — both the Doom and llama-server/PG exit hooks complete within their bounds.
- [ ] E-11: The real engine serves `GET /api/frame` 503 during graphics init — capture the transient window and confirm the window never latches `error` (R-1.4 natural lever); if the window is too racy to observe reliably, record that and cite the ST-6 frame-503 seam request.
- [ ] E-12: Run `scripts/doom/build-restful-doom.ps1` twice concurrently — is staging idempotent, with no half-written `restful-doom.exe`?
- [ ] E-13 (SUPERSEDED by #3013 — the anti-stub env seam is REMOVED; a stub can no longer be offered as a real engine. Kept for history; see the #3013 probes E-53..): Launch with the (now-removed) anti-stub env seam and a real engine whose basename differs only in case (`RESTFUL-DOOM.EXE`) — does the guard match case-insensitively on Windows?
- [ ] E-14: While the real engine runs, check `tasklist` for any SDL-spawned second window/process — none beyond the engine PID.

---

## Autonomous-play slice (Spec #2969) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the
> `telemetry_spans` live-pipeline reference (managed `psql` on the PG default, G-284; a
> disclosed `telemetry_get_stats` substitution allowed).
>
> **G-300:** every error/failure probe names an in-repo induction lever (scripted
> `{"malformed":true}`/`{"error":...}`, `FREDO_DOOM_STUB_EPISODE_FAIL=1`, stub death/exit
> levers) or is marked a static/unit pin, non-AC.

- [x] E-15 (PASS 2026-10-04 #2969 r1 — stop mid-run → phase idle, steps 531→534, no in-flight request, no orphan): `stop_doom_autoplay` mid-decision — does the loop stop cooperatively within its
  bound (`Stopping`→`Idle`), leaving no in-flight engine request and no orphan? (Lever: scripted loop + stop.)
- [x] E-16 (PASS 2026-10-04 #2969 r1 — the loop is strictly sequential read→decide→step, so a terminal observation is only seen on the post-step read; the DIE_AFTER leg showed each death → exactly one clean restart with no lost/duplicated episode call and no panic; unit pin `a_dead_observation_restarts_once_then_resumes`): A death observation arrives exactly while a `POST /api/step` is in flight — is the
  restart deferred to the next iteration cleanly (no lost/duplicated episode call, no panic)?
- [x] E-17 (PASS 2026-10-04 #2969 r1 — script `[malformed,error,good,out-of-range,malformed,error]`: failures=5 but final consecutiveFailures=3, proving the good decision reset the counter; loop resumed then failed at the 3rd consecutive): A malformed decision repeatedly with a good decision interleaved — does
  `consecutiveFailures` reset on the good decision and the loop resume, rather than latching Failed?
- [x] E-18 (PASS 2026-10-04 #2969 r1 — DIE_AFTER=2 + EPISODE_FAIL=1: step2 dead → episode 500 → phase=failed code=engineRequestFailed within bound, no spin): Death while `FREDO_DOOM_STUB_EPISODE_FAIL=1` — does the loop surface
  `EngineRequestFailed` within the bound without hanging or spinning? (Lever: stub episode-500.)
- [x] E-19 (PASS 2026-10-04 #2969 r1 — `start_doom_autoplay{maxSteps:2}` → completed, steps=2, code budgetExhausted, no partial step): `FREDO_DOOM_AGENT_MAX_STEPS` set very low (e.g. 2) — does the loop stop cleanly at the
  cap with `BudgetExhausted` and no partial step? (Lever: env override.)
- [x] E-20 (PASS 2026-10-04 #2969 r1 — 2nd start while running returned the live run (steps=239, not a reset) → single loop, no doubled rate, no second engine): Two `start_doom_autoplay` invocations in quick succession — is exactly one loop
  running (idempotent start), with no doubled `steps` rate and no second engine?

---

## Secret-activation slice (Spec #2970) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the
> `telemetry_spans` live-pipeline reference (managed `psql` at the manifest `ports.pg`,
> G-284; a disclosed substitution allowed).
>
> **G-300:** every error/failure probe names an in-repo induction lever
> (`FREDO_DOOM_MODE_FAIL_ENTER=1`, `FREDO_DOOM_IWAD_PATH=...missing.wad`,
> `FREDO_DOOM_STOP_TIMEOUT_S` + `FREDO_DOOM_STUB_HANG=1`) or is marked a static/unit pin, non-AC.
> The engine-path lever used by this historical slice is REMOVED by #3013 (see the #3013 probes).

- [x] E-21 (OBSERVATION 2026-10-05 #2970 r1 — with focus in `launcher-command-input`, `iddqd` did NOT activate (mode stayed `inactive`). `useSecretCode` deliberately ignores keydowns originating inside `input`/`textarea`/`select`/`[contenteditable]` (`useSecretCode.ts:19-24,45`) so ordinary typing cannot hijack a field. This DEVIATES from the plan's F-33 edge ("focus in an input still triggers"); the F-33 core criteria pass. Disclosed, not a core FAIL — deliberate, documented design): Type `iddqd` while a text input is focused — does the document-level listener (`useKonamiCode.ts:55-60`) still trigger, or does the field swallow it? (Lever: real engine; observe the mode event.)
- [x] E-22 (PASS 2026-10-05 #2970 r1 — `begin_enter` returns false while `entering`/`active`, so a second trigger is a no-op success; F-34 verified re-trigger while active keeps ONE window/PID and unchanged `enteredAt`; the `entering` case is the same pure transition, unit-pinned in mode.rs): Trigger the typed activation while the mode is already `entering` — is the second attempt a clean no-op (no second runtime, no second window)? (Lever: real engine; poll PIDs + window list.)
- [x] E-23 (PASS 2026-10-05 #2970 r1 — the autoplay loop issues `POST /api/step` continuously; closing the `doom` window mid-run (F-40) completed the bounded teardown with no panic and zero `restful-doom.exe`): Close the `doom` window at the same instant as a `doom_step` is in flight — does exit complete cleanly with no panic and no orphan? (Lever: real engine + `doom-exit-button`/native close.)
- [x] E-24 (PASS 2026-10-05 #2970 r1 — consumer-negative: an unrelated `llm-skill-call {skill:"weather"}` left the mode `inactive` with no half-entered state. Live model-audio ambiguous-phrase leg not driven (technique limitation, same as F-36/F-37)): Speak an ambiguous phrase ("fredo, do the thing") through the model-audio path — does the model avoid `doom_mode`, leaving the mode inactive with no half-entered state? (Lever: live model-audio turn; inspect `llm-skill-call`.)
- [x] E-25 (PASS 2026-10-05 #2970 r1 — every fresh boot observed across the round started `inactive` (mode never persisted); the app's startup sweep reclaimed orphaned `restful-doom.exe`/`postgres.exe` left by hard-killed dev-env cycles): Enter the mode, then hard-kill Fredo — on relaunch is the mode `inactive` (no persistence) and is the orphan engine swept? (Lever: hard-kill + relaunch.)
- [x] E-26 (PASS 2026-10-05 #2970 r1 — while active `stt_start` refused `{started:false,code:"disabled"}`; the module-scoped `performanceGate` drives the launcher `voiceAvailable` gate (ST-6 unit test `launcherDoomSuppression` + the bar error surface forced empty). Direct launcher-hold gesture not driven (the launcher bar was occluded by the Setup window frame); backend suppression verified): While active, exercise the launcher voice affordance — is it gated (`performanceGate`) with no voice error surfaced, and does `stt_start` still refuse with `code:"disabled"`? (Lever: real engine + suppression.)
- [x] E-27 (PASS 2026-10-05 #2970 r1 — exit is idempotent: `begin_exit` returns false when already `exiting`/`inactive`; F-43 verified an exit-while-inactive is a no-op success; observed the `exiting` phase settling cleanly to `inactive` with no error, no residual suppression, no orphan): Exit via the `doom` window close while a spoken "stop" is also being processed — is the double exit idempotent (no error, no residual suppression, no orphan)? (Lever: real engine + `doom_mode {action:"exit"}`.)
- [x] E-28 (PASS 2026-10-05 #2970 r1 — re-entered Doom Mode multiple times after exits (typed and voice); each enter produced a fresh `enteredAt`, a fresh engine PID, and exactly ONE `doom` window, with no stale window): After an R-3.b exit, immediately re-type `iddqd` — does the mode re-enter cleanly with a fresh runtime and `enteredAt`, no stale window? (Lever: real engine; poll PIDs + `doom-mode-changed`.)

---

## Whole-app theme + armored avatar slice (Spec #2971) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the
> `telemetry_spans` live-pipeline reference (managed `psql` on the PG default, G-284, or a
> disclosed app-pool fallback, G-307).
>
> **G-300:** every error/failure probe names an in-repo induction lever
> (`FREDO_DOOM_MODE_FAIL_ENTER=1`, a `setDoomVisualEngaged` unit drive) or is marked a
> static/unit pin, non-AC.

- [x] E-29 (PASS 2026-10-05 #2971 r1 — 4 enter/exit cycles (typed + button); theme + armor settled correctly each time, no stale class/var, no `Maximum update depth exceeded`): Rapid enter/exit/enter — does the theme + armor settle correctly with no stale class/var and no console re-render loop? (Lever: real engine + typed `iddqd`/exit; watch for `Maximum update depth exceeded`.)
- [ ] E-30: Failed enter with `FREDO_DOOM_MODE_FAIL_ENTER=1` while a non-default preset is active — is there ANY transient Doom frame, and is the preset fully intact afterward? (Lever: env override.)
- [x] E-31 (PASS 2026-10-05 #2971 r1 — opening the Mission Monitor window while engaged left the main window engaged + armored; cleared only at `inactive`; module-scoped store): Remount/reopen a window while engaged — does the armor/theme persist (module-scoped store) and clear only at `inactive`? (Lever: real engine; reopen a window.)
- [x] E-32 (PASS 2026-10-05 #2971 r1 — distinct accent `#ff2fd0` → engaged `--accent-primary #8fbf3f` + `--accent-contrast` recomputed `#0c1117`; restored exactly on exit): Accent interplay — enter with a distinct accent, confirm `--accent-contrast` flips to the Doom accent's contrast and restores exactly on exit. (Lever: real engine + an accent override.)
- [ ] E-33: Open Settings→Appearance while engaged — does the theme/preset UI still function, and does changing a preset while engaged have any interaction with the Doom layer? (Lever: real engine.)
- [x] E-34 (PASS 2026-10-05 #2971 r1 — 3 forced `resize` re-renders + an input event → 5/5 samples stable (doom-mode, #14170f, #8fbf3f, armor); no `Maximum update depth exceeded`): Force ≥5 re-renders while engaged — do the theme vars and armor stay stable with no `Maximum update depth exceeded`? (Lever: unit render loop + live.)

---

## Resume-across-sessions slice (Spec #2972) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the
> `telemetry_spans` live-pipeline reference (managed `psql` on the PG default, G-284, or a
> disclosed app-pool fallback, G-307).
>
> **G-300:** every error/failure probe names an in-repo induction lever (`FREDO_DOOM_SAVE_STATE_DIR`
> pointing at a corrupt/absent/unwritable path, `FREDO_DOOM_SAVE_FORCE_FAIL=read|write`,
> `FREDO_DOOM_STUB_EPISODE_FAIL=1`, `FREDO_DOOM_STUB_DONE_AFTER=<n>`) or is marked a static/unit pin, non-AC.
> `FREDO_DOOM_SAVE_FILE` is REMOVED (#3011) — probes must use the state-dir lever.

- [ ] E-35 (updated #3011): Write a `DoomSave` with an UNKNOWN `version` (e.g. `2`) to `<FREDO_DOOM_SAVE_STATE_DIR>/doom-save.json` — does the loader reject it (`hasSave:false`, clean run) rather than migrating/partially applying? (Lever: state-dir fixture.)
- [ ] E-36: Hard-kill Fredo mid-run (between advances), then relaunch — is the last persisted `feature_doom_save` row the resume point, and is the orphan engine swept? (Lever: hard-kill + relaunch.)
- [ ] E-37 (updated #3011): Start a fresh run, then close the `doom` window before the first advance — is the prior save (PG row / state-dir fixture) unchanged, with no partial overwrite? (Lever: `freshStart:true` + early close.)
- [ ] E-38 (updated #3011): Point `FREDO_DOOM_SAVE_STATE_DIR` at an unwritable path (a directory at `doom-save.json`) during a stub advance — does the run keep progressing (best-effort write) with a logged, non-fatal failure? (Lever: unwritable state-dir path.) Also try `FREDO_DOOM_SAVE_FORCE_FAIL=write`.
- [ ] E-39: Two `start_doom_autoplay` calls in quick succession, one `{freshStart:true}` and one `{}` — is exactly one loop running with a single coherent campaign (no double resume/advance)? (Lever: scripted stub + IPC monitor.)

---

## Dedicated PostgreSQL feature-store slice (Spec #3011) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the `telemetry_spans`
> reference and the app-pool read `application_store_query` (G-284/G-307; `psql` NOT named).
>
> **G-300:** every error/failure probe names an in-repo lever (`FREDO_DOOM_SAVE_STATE_DIR`,
> `FREDO_DOOM_SAVE_FORCE_FAIL=read|write`, `FREDO_DOOM_STUB_EPISODE_FAIL=1`) or is a static/unit pin.

- [ ] E-40: Kill the app BETWEEN the progress-writer upsert and the pool commit — is the singleton row left consistent (no partial/duplicate), and does the next start read a valid save or a clean no-save? (Lever: hard-kill + relaunch; PG WAL.)
- [ ] E-41: `FREDO_DOOM_SAVE_FORCE_FAIL=write` during a live level transition — does the run continue and is the PG row provably UNCHANGED (no write)? (Lever: forced-write seam.)
- [ ] E-42: Set `FREDO_DOOM_SAVE_FORCE_FAIL` to an UNKNOWN value (e.g. `bogus`) and to a blank string — is the seam inert (normal save/resume)? (Lever: env override.)
- [ ] E-43: Seed a valid state-dir fixture AND a conflicting existing PG row (state-dir set) — is the state-dir lever authoritative for the leg, and does it leave the PG row untouched? (Lever: state-dir + `application_store_query`.)
- [ ] E-44: `reset_doom_save` while a run is active — does it delete the singleton row (the only delete path), return `hasSave:false`, and NOT re-persist until the next advance? (Lever: command + row read.)

---

## Engine-provisioning slice (Spec #3012) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the `telemetry_spans`
> reference (app-pool read, G-307; fallback managed `psql` at the manifest `ports.pg`, G-284,
> DISCLOSED).
>
> **G-300:** every error/failure probe names an in-repo lever (`FREDO_DOOM_BUILD_OFFLINE=1`,
> `FREDO_DOOM_TOOLCHAIN_ROOT` lacking bash, `FREDO_DOOM_TOOLCHAIN_ARCHIVE_URL/_SHA256/_BYTES`,
> `FREDO_DOOM_SOURCE_DIR`, UI cancel, a test-only timeout override) or is a static/unit pin, non-AC.

- [ ] E-45: Double-click `doom-provision-confirm` / invoke `provision_doom_engine` twice in quick succession — is exactly ONE provisioning run active (idempotent), with no doubled download and no second build tree? (Lever: IPC monitor + process inventory.)
- [ ] E-46: Cancel exactly as the build stages the engine — is the half-written `restful-doom.exe` discarded (never launched), with zero orphans? (Lever: `doom-provision-cancel` timed at the `stage` step.)
- [ ] E-47: Set `FREDO_DOOM_TOOLCHAIN_ROOT` to a dir containing a `usr/bin/bash.exe` that is NOT runnable (e.g. a text file named `bash.exe`) — does the usable-root probe still reject it (`toolchainUnavailable`) rather than mis-launch? (Lever: crafted root.)
- [ ] E-48: Hard-kill Fredo mid-build, then relaunch — is the build child swept, is no half-engine considered staged, and does the next activation re-provision cleanly? (Lever: hard-kill + relaunch.)
- [ ] E-49: Replace `vendor/restful-doom/` contents with a tree at a DIFFERENT commit (or with the marker removed) while a staged engine exists — does the marker mismatch force re-provision? (Lever: scratch copy + `FREDO_DOOM_SOURCE_DIR`.)
- [ ] E-50: Corrupt `.restful-doom-commit` (blank/whitespace) with the `.exe` present — is the staged engine rejected and provisioning re-run? (Lever: fixture marker.)
- [ ] E-51: Interleave a failed provisioning with an existing healthy staged engine — is the previously staged engine left untouched (fail-closed), or is it clobbered? (Lever: `FREDO_DOOM_BUILD_OFFLINE=1` on a healthy install.)
- [ ] E-52: Point `FREDO_DOOM_INSTALL_DIR` at an unwritable directory — is the failure typed (`installDirInvalid`) with no crash and no orphan? (Lever: read-only/absent dir.)

---

## Managed-only engine resolution slice (Spec #3013) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the `telemetry_spans`
> live-pipeline reference (non-zero count + recent `max(ingested_at)`; app-pool read, G-307; fallback
> managed `psql` at the manifest `ports.pg`, G-284, DISCLOSED). Doom emits no span.
>
> **G-300:** every error/failure probe names an in-repo lever (`FREDO_DOOM_FAIL_ENGINE_SPAWN=1`, the
> `fail-engine`/`absent` fixture dirs under `.opencode/tmp/3013/fixtures/`, retained
> `FREDO_DOOM_INSTALL_DIR`) or is marked a static/unit pin, non-AC.

- [ ] E-53: Put a DIFFERENT `restful-doom.exe` earlier on `PATH` — does resolution still pick the managed `<install_dir>/engine/restful-doom.exe` (PATH never consulted)? (Lever: PATH-scoped copy + managed fixture.)
- [ ] E-54: Seed the (removed) engine-path setting row in the AppStore and set the (removed) engine-path env seam to a valid engine — is BOTH ignored (managed-only), with the managed engine still chosen? (Lever: seeded setting + env; observe `DoomStatus.enginePath`.)
- [ ] E-55: Corrupt `.restful-doom-commit` (blank/whitespace) while the managed `.exe` is present — is the staged predicate rejected (`provisionFailed`/provisioning state) with NO substitute and NO download? (Lever: fixture marker.)
- [ ] E-56: Set `FREDO_DOOM_FAIL_ENGINE_SPAWN` to unknown/blank values (`""`, `"yes"`, `"2"`, `"01"`) — is the lever inert (launch proceeds) in every case, active ONLY for a trimmed `"1"`? (Lever: env override over a staged managed engine.)
- [ ] E-57: Relocate/remove the managed install dir between two boots — does boot 2 report the provisioning/failure state with NO filesystem hunt outside the repo + managed dir (G-172)? (Lever: retained `FREDO_DOOM_INSTALL_DIR`.)
- [ ] E-58: Invoke `launch_doom_runtime` twice in quick succession with a staged managed engine — exactly ONE managed engine PID, ONE `doom` window, idempotent (no second spawn, no re-download)? (Lever: managed fixture + `tasklist`.)

---

## Game-only window + auto-play slice (Spec #3007) — unscripted probes

> **Verification policy: live** — probes run against the running artifact with the `telemetry_spans`
> live-pipeline reference (NON-ZERO count + recent `max(ingested_at)`). Doom emits no span — the query
> proves the pipeline, not the feature; DISCLOSE.
>
> **G-300:** every error/failure probe names an in-repo lever — `FREDO_DOOM_STUB_EXIT=1` (readyTimeout),
> `FREDO_DOOM_STUB_HANG=1` (bounded stop/hard-kill ONLY), `FREDO_DOOM_STUB_FRAME_503=<count|duration>`
> (transient reconnecting), `FREDO_DOOM_STUB_FAIL=state|step|frame` (hard-500 typed error),
> `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` + `FREDO_DOOM_AGENT_SCRIPT`, `FREDO_DOOM_MODE_FAIL_ENTER=1`,
> `FREDO_DOOM_FAIL_ENGINE_SPAWN=1` — or is marked a static/unit pin, non-AC. (G-316 semantics: `_HANG`
> is NOT the readyTimeout lever.)

- [ ] E-59: Reopen/remount the `doom` window while engaged — does the game-only surface rebuild WITHOUT flashing any removed chrome, and does autoplay continue as exactly ONE loop (no second `try_begin`, one engine PID)? (Lever: real engine; reopen + poll `get_doom_autoplay_status`/PIDs.)
- [ ] E-60: Rapid close → re-enter (`iddqd`) cycles — is there any stale window, a leftover engine PID, or a second autoplay loop between cycles? (Lever: MCP close lever + `tasklist` + status.)
- [ ] E-61: Drive an autoplay failure (`FREDO_DOOM_AGENT_SCRIPT={"malformed":true}`) AND a transient frame error (`FREDO_DOOM_STUB_FRAME_503=<count>`) at once — do the two top-right notes (`doom-autoplay-note` + `doom-frame-reconnecting`) stack without reflowing/shrinking the canvas? (Lever: scripted + 503; G-273.)
- [ ] E-62: With the doom window open and the main window focused, cycle focus between them — does the shared hotkeys cluster stay ABSENT in the doom webview and UNCHANGED in the main window (no flicker/late mount)? (Lever: real engine + focus cycle.)
- [ ] E-63: Close the `doom` window while it is still `starting` (no live agent) — is the teardown idempotent (the agent-stop is a no-op on idle), bounded, and panic-free, leaving no engine PID? (Lever: `FREDO_DOOM_READY_TIMEOUT_S=6` + `FREDO_DOOM_STUB_EXIT=1` then close; poll PIDs.)
- [ ] E-64: Boot the app with no `doom` window ever opened — does any removed hook string leak into the main-window DOM (regression on the shared component tree)? (Lever: fresh boot + DOM snapshot; static/observation pin, non-AC.)
