# Voice Input — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the voice-input surface.
> Runs on a running Fredo POC on `spec/2876`. **Verification policy: live.**
> **Serving checkout:** `spec/2876 @ <sha>` (fill per round).

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — the launcher command bar renders (`input[role="searchbox"]`, `LauncherCommandBar.tsx:133`); open the launcher via the activation lever and assert the bar is present and focusable
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible (and confirm NO voice/STT/autosend section exists — autosend is out of spike scope)
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2876/e2e/smoke.jpeg")` succeeds

## #2876 extension — STT spike smoke

- [ ] S-6: Listening flow starts and stops — activate the listening flow (bar-focused branch), assert a listening cue appears before the first partial (e.g. placeholder `Listening…` / accent-tinted border), then stop; the app returns to the resting bar with no console `Error:`/`Uncaught`/`Maximum update depth exceeded` and `tauri_webview_screenshot` succeeds. **Test data:** real mic (or fixture). **If no mic/permission → named blocker (G-053) + unit/static pin, not a PASS.**
- [ ] S-7: Offline smoke — with the network blocked (and the block proven by a failing control fetch), start → speak a short phrase → stop; a transcript appears in the bar input and the app stays alive. **Test data:** network block + control fetch; real mic (or fixture).
- [ ] S-8: Evidence upload smoke — a capture is uploaded via `upload-evidence --issue 2876 --base spec/2876`, the raw URL resolves, and it is embedded in `## Tests Runs` with a textual description (the live-policy lever).

## Run log — round 1 (2026-09-14, `spec/2876` @ `df47d4f`)

- **S-1 PASS** — `tauri_webview_dom_snapshot(accessibility)` returned a non-empty launcher DOM (FREDO notch, searchbox, companion seat).
- **S-2 PASS (round start)** — `tauri_read_logs(console)` clean; only the pre-existing `motion() is deprecated` WARN. No `Error:`/`Uncaught`/`Maximum update depth exceeded` through the listening/model legs; console was clean again after the modelMissing/modelCorrupt legs.
- **S-3 PASS** — launcher command bar (`input[role="searchbox"]`) rendered + focusable; Ctrl+Space branch (2) started listening into it.
- **S-4 PASS** — Settings opened (Companion/Appearance/Fredo Setup/Telemetry nav + feature sections); **no voice/STT/autosend section** (voice lives inside Companion).
- **S-5 PASS** — screenshots captured under `.opencode/tmp/2876/e2e/` (uploaded).
- **S-6 PASS** — listening flow started on bar-focus; DR-1 cue present (`placeholder="Listening…"`, `data-testid="launcher-command-listening"`); stopped by Escape; console clean. (Real audio absent — virtual device.)
- **S-7 UNVERIFIED (G-053)** — no network-block lever in the sandbox (no firewall/adapter control); static pin: the voice module contains no remote client (`grep reqwest|hyper|websocket|TcpStream|UdpSocket` → none).
- **S-8 PASS** — 5 captures uploaded via `upload-evidence`; raw URLs embedded in `## Tests Runs` with descriptions.

## Run log — round 2 (2026-09-14, `spec/2876` @ `84ff1ac`, fix `d9a9f8d`)

- **S-1 PASS** — `tauri_webview_execute_js`/`dom_snapshot` returned a non-empty launcher DOM (`FREDO`, `input[role="searchbox"]`, `#fredo-launcher-grid`); one window `main`.
- **S-2 PASS** — `tauri_read_logs(console)` clean across every leg; only the pre-existing `motion() is deprecated` WARN. No `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- **S-3 PASS** — launcher command bar (`input[role="searchbox"]`, `aria-label="Search, launch, or message Fredo"`) rendered + interactive; `stt_start`/`stt_stop` drove the DR-1 cue (`placeholder="Listening…"` → `"search or command"`).
- **S-4 PASS (static re-confirm)** — no voice/STT/autosend settings section exists; the Settings surface was not re-driven this round (its host trigger is not mounted in the launcher view) — the UI sources are unchanged by the fix (`git diff df47d4f 84ff1ac`).
- **S-5 PASS** — 3 round-2 screenshots captured under `.opencode/tmp/2876/e2e/` and uploaded.
- **S-6 PASS** — listening started on the launcher path (`started:true`, 48000 Hz) with the cue present; stopped via `stt_stop`; console clean. (Real audio absent — virtual device.)
- **S-7 UNVERIFIED (G-053)** — no network-block lever in the sandbox; static pin unchanged (no remote client on the audio→text path).
- **S-8 PASS** — 3 uploads via `upload-evidence --issue 2876 --base spec/2876` (serial, G-144); raw URLs embedded in `## Tests Runs` with descriptions.

## #2877 extension — local STT foundation smoke

> Issue #2877 production-hardens the spike. **Serving checkout:** the `spec/2877` tip on a running
> Fredo desktop app. **Verification policy: live.**
>
> **SUPERSESSION:** this file's S-4 wording ("confirm NO voice/STT/autosend section exists — autosend
> is out of spike scope") is **SUPERSEDED** for #2877 — per the PO amendment, voice/STT settings
> (and the autosend setting) now live INSIDE the Companion section, hosted in the Settings app
> window. The historical S-4 record above is preserved; the new quick paths below assert the
> presence + persistence of those controls. **MOVED to #2878:** transcript → launcher-bar wiring is
> not smoked here.

- [ ] S-9: Voice controls reachable + persisted — open the Settings app window → Companion; the voice group (enable toggle + model status, and the device/autosend controls when present) renders; toggle the enable control, restart the app, and re-read it. **Expected:** the controls render under Companion (no dedicated Voice section/nav) and the toggled value persists across the restart; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-10: Model step quick path — with the STT model absent, the Companion `sttModel` step renders with a single acquire action + a state; the step is in the wizard's Optional group and does NOT change the gating `installed/total` summary. **Expected:** one-action setup affordance present; counts stay GGUF-only; screenshot succeeds.
- [ ] S-11: Listening quick path — start listening (voice enabled), assert a visible active-capture indicator (and no capture without it), then stop and confirm the indicator clears and the app returns to rest. **Expected:** indicator present exactly while `listening`; no console `Error:`/`Uncaught`/`Maximum update depth exceeded`; screenshot succeeds. **If no mic/permission/engine → named blocker (G-053) + unit/static pin, not a PASS.**

## Run log — #2877 round 1 (2026-09-15, `spec/2877` @ `dbb3843`)

- **S-9 PASS** — Settings app window → Companion rendered the "Voice input" group (enable switch, engine status, model row ready + location, device select, autosend) inside the Companion section with NO dedicated Voice nav/section; toggling the enable control persisted `Fredo_companion_voice_enabled` and survived a full app restart (control restored `checked`). Screenshot + DOM structure captured; console clean (only the pre-existing `motion() is deprecated` WARN).
- **S-10 PASS** — the `sttModel` step renders in the wizard's **Optional** group ("Not required for companion chat"); the gating summary stays GGUF-only ("2 of 3 prerequisites ready" / "0 of 3 present") while the optional STT step showed "4 of 4 present"; from an empty scratch `models_dir` (MS-V0) the step exposed ONE "Download voice model" action which acquired all 4 files in one click.
- **S-11 PASS** — launcher-origin start showed the DR-7 cue (dot + `Listening` chip + Stop + `Listening…` placeholder) exactly while `listening`; stop cleared it. Companion-origin start showed the DR-8 bubble (dot + Listening… + 6 s hearing-nothing hint + Stop) with the launcher cue absent (exactly one indicator per session). Console clean before/after. Real audio absent (silent virtual device) — a named blocker on F-24/F-26, not on the smoke path.

## #2882 extension — hold-Space dictation quick paths

> Issue #2882 moves the dictation trigger to a HELD Space in the focused empty search bar and retires
> the Ctrl+Space listening cascade. Quick paths only — the full matrix lives in
> `functional.md` F-66..F-72 / `regression.md` R-18..R-20. **Verification policy: live.**

- [ ] S-12: **Hold Space dictates.** With voice enabled + model ready, focus `input[role="searchbox"]`
      (EMPTY value), `keyboard(action="down", key=" ")`, hold 1500 ms, then `action="up"`.
      **Expected:** a visible listening cue (dot/chip/Stop + `Listening…`) appears on the `down` and
      clears on the `up` (`stt_status.listening` `true` → `false`); exactly ONE `stt_start`;
      screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
      The audible leg is a NAMED BLOCKER on this host (no physical mic) — use the synthetic
      `stt:transcript` lever for content and record it.
- [ ] S-13: **`set` dictated goes to Fredo, not to Settings.** Autosend OFF; hold Space → synthetic
      final `set` → release; then Enter. **Expected:** the text waits in the bar on release, then ONE
      dispatch to Fredo and ZERO windows (`Settings` NEVER opens from a dictated phrase); screenshot
      succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2887 extension — instant hold-to-dictate quick paths

> Issue #2887 keeps the recognizer ready while idle so the hold-Space dictation starts with no
> perceptible wait, and keeps the indicator honest. Quick paths only — the full matrix lives in
> `functional.md` F-74..F-82 / `regression.md` R-21..R-24 and `launcher` F-82..F-84 /
> R-50..R-53. **Verification policy: live.**

- [ ] S-14: **Resident-ready dictation quick path.** With voice enabled + model ready and the app idle
      (no dictation yet this session), focus the EMPTY `input[role="searchbox"]`, record the press
      timestamp in the dispatch task, `keyboard(action="down", key=" ")`, hold 1500 ms, sample the cue
      mid-hold, `action="up"`. **Expected:** the cue (`launcher-command-listening` dot/chip + `Listening…`
      placeholder) appears within the warm bound and is present for the whole hold; the cue is NEVER
      present before the capture-active marker; `stt_status.listening` `true` → `false`; exactly ONE
      `stt_start`; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth
      exceeded`. (Content leg = the synthetic `stt:transcript` lever; the audible leg is a NAMED
      BLOCKER on this host — no physical mic.)
- [ ] S-15: **Cold first-dictation quick path.** Restart the app (`dev-env` Down→Up); with voice
      enabled + model ready, make the FIRST dictation of the process: press the empty focused bar and
      hold. **Expected:** the cue appears within the cold bound (`T_COLD_MAX_MS`; default ≤ 900 ms) and
      is never present before capture is active; release releases the mic; the hold dictates; screenshot
      succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-16: **Evidence upload smoke.** A capture from S-14/S-15 is uploaded via
      `upload-evidence --issue 2887 --base spec/2887`, the raw URL resolves, and it is embedded in
      `## Tests Runs` with a textual description (the live-policy lever); the `## Tests Runs` body also
      references `telemetry_spans` + the timestamped capture markers.

### #2887 testing round 1 — result (`spec/2887 @ 706fcd9d`, 2026-09-17, live)

**Verdict FAIL** — 5 PASS / 2 FAIL / 1 UNVERIFIED of 8 requirement rows. Full report: `## Tests Runs (round 1)` on #2887.

- S-14 **PASS** — warm holds, engine resident 10/10 (`engineResident:true`). Press marker = capture-phase `keydown` `performance.now()` in the same dispatch as `tauri_webview_keyboard(action="down", key=" ")`; capture-active = the `stt:state{listening:true}` receipt. `T` series **275.3 / 226.4 / 230.5 / 231.5 / 231.4 / 230.4 / 225.4 / 225.5 / 233.7 / 223.0 ms** ⇒ p50 **230.5** / p95 **275.3** / max **275.3** (plan budget 250/300/320 — PASS against the PLAN constants, not this file's 500/750 placeholders). Cue present in ZERO samples before capture-live; first cue frame +15.0…+23.5 ms AFTER the live event; `launcher-command-listening-pending` never rendered on a resident hold (0/12). Exactly ONE `stt_start` per hold. Console clean.
- S-15 **FAIL (AC4B)** — the resident-kill lever (the dispatch's sanctioned (B) lever) measured **T = 5019.1 ms** against `T_LAUNCH_COLD_MAX_MS = 3820` (`readyMs` 4816, `engineResident:false`, chip `starting voice input…` for 4626.1 ms, no error, engine re-parked). `T_LAUNCH_WARM_MS` = **4606 ms** (single sample ≤ 5000). `T_LAUNCH_WINDOW_MS` UNVERIFIED: after the mid-round relaunch the MCP bridge only answered after a `driver_session` stop+start, at `performance.now()=32388 ms` — far outside the ≤3500 ms window (by then the engine was already resident). **Do NOT score the launch window against `T_COLD_MAX_MS`.** The cold-idle cohort PASSES: 324 248 ms idle + `engineResident:true` ⇒ T **243.5 ms** ≤ 320, delta vs warm **+13.05 ms** ≤ 50.
- S-16 **PASS** — 5 captures uploaded serially via `upload-evidence --issue 2887 --base spec/2887` (raw URLs in the `## Tests Runs` table); the report also carries the `telemetry_spans` receipt (4 519 rows, newest `ingested_at` 2026-09-17T23:42:04.914Z) + the `fredo emit` marker rows. **AC2's opening-word read is a NAMED BLOCKER** — the `FREDO_STT_FEED_WAV` seam was not exercised (the tester cannot set the process env var); the synthetic content lever proved only the finalize/commit wiring.

**Suite divergence (reported, not adopted):** this file's S-15 text still carries the triage-era `T_COLD_MAX_MS; default ≤ 900 ms` placeholder. The plan's constants supersede it. The bar selector in S-14 is also stale — the live element is `textarea[data-testid="launcher-command-input"] role="searchbox"`, not `input[role="searchbox"]`.

## #2888 extension — sentence-case dictation + the name `Fredo` quick paths

> Issue #2888 renders dictated text in ordinary written casing and recognizes the name `Fredo`.
> Quick paths only — the full matrix lives in `functional.md` F-83..F-101 / `regression.md`
> R-25..R-29. **Verification policy: live.** Content comes from the L3 synthetic `stt:transcript`
> lever on the REAL `adapterBridge.listen` channel; the lifecycle/cue comes from the REAL gesture +
> control plane. **The host has no physical mic and no WAV asset exists in-repo — the audible leg is
> a named blocker, never a PASS.**

- [ ] S-17: **Sentence-case quick path.** Voice enabled + model ready; focus the EMPTY
      `textarea[data-testid="launcher-command-input"][role="searchbox"]`; `keyboard(action="down",
      key=" ")` → hold ≥ 400 ms → inject a final `DEPLOY THE BUILD TONIGHT` on L3 → `action="up"`.
      **Expected:** the bar `value` is exactly `Deploy the build tonight` (the opening capitalised,
      ordinary words lowercased); a mid-hold PARTIAL sample shows the normalised form too (never the
      raw ALL-CAPS); the cue behaved as in S-14; screenshot succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-18: **`Fredo` quick path — message, never a launch.** Autosend OFF; hold → inject final
      `ASK FREDO TO OPEN THE LOGS` → release; then Enter. **Expected:** the bar waits as editable text
      with the hint `↵ send transcript to Fredo`, then exactly ONE dispatch to Fredo and ZERO windows
      (`Settings`/`Fredo` never open an app); screenshot succeeds; console clean.
- [ ] S-19: **Evidence upload smoke.** A capture from S-17/S-18 is uploaded via
      `upload-evidence --issue 2888 --base spec/2888`, the raw URL resolves, and it is embedded in
      `## Tests Runs` with a textual description (the live-policy lever); the `## Tests Runs` body also
      references `telemetry_spans` + the round's `fredo emit` marker rows.

### #2888 testing round 1 — result

- [ ] _(pending — the Tester appends the smoke results; do not pre-fill)_

---

## #2897 extension — speech-handling mode quick paths

> Issue #2897 adds the **local transcription vs model audio** choice. Quick paths only — the full matrix
> lives in `functional.md` F-102..F-110 / `regression.md` R-30..R-34 / `exploratory.md` E-52..E-58, and the
> lever in `.opencode/tests/voice-dictation/`. **Verification policy: live.**
>
> **The host has no physical mic** — the audio lever is `FREDO_STT_FEED_WAV` (the in-repo fixture, always
> paired with an UNSET-env control); the audible-content leg is a named blocker, never a PASS.

- [ ] S-20: **Selector reachable + persists.** Settings app window → Companion → voice group; the
      `companion-voice-handling-select` renders with `Local transcription` / `Model audio`; select
      `Model audio`; read `Fredo_companion_voice_handling`; restart the app and re-read.
      **Expected:** default `'local'`; the change persists byte-exactly and the selector reflects it; screenshot
      succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-21: **Model-audio listening quick path (no transcript).** With `model` selected and the managed server
      running, hold Space (L1); sample the bar; release/stop.
      **Expected:** a `Fredo is listening` indicator (chip/placeholder) is present for the capture with NO
      dictated words anywhere (see `functional.md` F-104), then the state clears; the transcript announcer stays
      empty; screenshot succeeds; console clean. **If the pinned model cannot take audio (ST-0 negative) → this
      quick path asserts the F-107 fallback surface instead — never a fabricated delivery.**
- [ ] S-22: **Evidence + telemetry receipt.** A capture from S-20/S-21 is uploaded via
      `upload-evidence --issue 2897`, the raw URL resolves, and it is embedded in `## Tests Runs` with a textual
      description; the body also references `telemetry_spans` (non-zero, recent `max(ingested_at)`).
- [ ] S-23: **Over-limit fixture generator available (the F-106 lever, ST-9).** Run
      `node .opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs --seconds 31` twice; hash and
      parse each output (`--seconds=31` must be equivalent).
      **Expected:** `dictation-31s-16k-mono.wav` is written to the fixtures dir, byte-identical across the two runs
      (deterministic — no randomness/clock), 16 kHz mono 16-bit PCM, **496,000 samples (31 s)**, data length
      **992,000 B**; the generator with NO argument still rewrites `dictation-phrase-16k-mono.wav` byte-for-byte
      (F-1's contract holds); the variant is generated on demand and is **not** committed.
      **Edge:** a non-integer `--seconds` is rejected with a non-zero exit and writes nothing; the artifact is
      generated in-repo only (G-172 — never source a long WAV from outside).

### #2897 testing round 1 — result (`spec/2897 @ b2b2e4df`, 2026-09-19, live)

- **S-20 PASS** — Settings → Companion `Speech handling` selector rendered `Local transcription` / `Model audio`, default `local`; selecting `Model audio` persisted `Fredo_companion_voice_handling="model"` and survived a full restart.
- **S-21 PASS** — model-audio listening quick path: `Fredo is listening` chip + `Fredo is listening…` placeholder for the capture, **no** dictated words anywhere, cleared on stop; the model-audio `processing` chip then did not clear after the reply (see F-104 FAIL).
- **S-22 PASS** — 8 captures uploaded via `upload-evidence --issue 2897`; the report references `telemetry_spans` (13,700 rows, newest `ingested_at` 2026-09-19T11:26:31.278557800+00:00).
- **S-23 PASS** — `generate-dictation-phrase.mjs --seconds 31` → `dictation-31s-16k-mono.wav`, 16 kHz mono 16-bit, 496,000 samples / 992,000 B, SHA-256 `06a192e6…`; no-arg path byte-identical to the developer receipt (`33c2f129…`).

### #2897 testing round 2 — result (`spec/2897 @ be4d3a73`, 2026-09-19, live)

- **S-20 PASS** — `companion-voice-handling-select` rendered `Local transcription` / `Model audio`
  (default `local`); selecting `local` persisted SQLite `"local"`, then `model` persisted select
  `"model"` + localStorage `"model"` + SQLite `"model"` and flipped the help copy.
- **S-21 PASS** — model-audio listening quick path: `Fredo is listening` chip + `Fredo is listening…`
  placeholder, no dictated words; the chip now also **clears on `llm-done`** (round-1 F-104 defect fixed).
- **S-22 PASS** — 5 captures uploaded via `upload-evidence --issue 2897`; the report references
  `telemetry_spans` (14,296 rows, newest `ingested_at` `2026-09-19T12:06:42.903606400+00:00`).
- **S-23 PASS** — 31 s variant re-generated: 496,000 samples / 992,000 B, SHA-256 `06a192e6…`;
  committed 1.6 s fixture SHA-256 `33c2f129…` unchanged.
- **Env form:** `-EnvVars @{ … }` via `powershell -File` remains broken (hashtable→string); the feed ran
  from the parent env of the allowlisted `bun` launcher (disclosed tooling gap).

---

## #2903 extension — model-audio app action quick paths

> Issue #2903 makes the model-audio path perform app open/close requests. Quick paths only — the full
> matrix lives in `functional.md` F-111..F-126 / `regression.md` R-35..R-40 / `exploratory.md`
> E-59..E-64. **Verification policy: live.** App-action content uses L3 (`llm-skill-call` on the REAL
> channel); the audio lifecycle uses L4. **The host has no physical mic and no intelligible in-repo
> audio — the acoustic leg is a NAMED BLOCKER, never a PASS.**

- [ ] S-24: **Model-audio open quick path.** Select `Model audio` (`companion-voice-handling-select`,
      `Fredo_companion_voice_handling='model'`); managed server healthy; `stt_start{origin:"launcher"}`;
      with the model chip `launcher-command-model-processing-chip` present, emit
      `llm-skill-call {skill:"open_app", arguments:{app:"Settings"}}`.
      **Expected:** the Settings window opens (`.fredo-window__surface[role="group"][aria-label="Settings"]`)
      AND the reply reads exactly `Opening Settings` on `fredo-companion-live-region`; no transcript; no
      raw tool JSON; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth
      exceeded`.
- [ ] S-25: **Unrecognized-app quick path.** Same setup; emit `llm-skill-call {app:"Narnia"}`; also type
      `Narnia` + Enter on the typed path.
      **Expected:** ZERO windows on BOTH paths (the app grid stays present — G-170) and the reply reads
      exactly `I couldn't find "Narnia"`; no false success; console clean.
- [ ] S-26: **Typed/companion parity quick path.** Type `open settings` into the bar + Enter.
      **Expected:** the SAME Settings window opens with the SAME `Opening Settings` reply as S-24 (AC3
      parity); screenshot succeeds; console clean.
- [ ] S-27: **Evidence + telemetry receipt.** A capture from S-24/S-25 is uploaded via
      `upload-evidence --issue 2903`, the raw URL resolves, and it is embedded in `## Tests Runs` with a
      textual description; the body also references `telemetry_spans` (non-zero, recent
      `max(ingested_at)`).

### #2903 testing round 1 — result (`spec/2903 @ 813b0060`, 2026-09-20, live)

- **S-24 PASS.** Mode=`model` (`Fredo_companion_voice_handling='model'`), managed server healthy; live model-audio turn + L3 `{open_app,{app:"Settings"}}` → Settings window opened + live region `Opening Settings`; no transcript; no raw tool JSON; console clean. Screenshot `f111-open-settings.jpeg`.
- **S-25 PASS.** `{open_app,{app:"Narnia"}}` and `{close_app,{app:"Narnia"}}` → ZERO windows (grid intact) + `I couldn't find "Narnia"`; typed `Narnia` via the L3 channel on both intents. Screenshot `f122-unknown-narnia.jpeg`.
- **S-26 PASS.** Typed `open settings` + Enter → the real model selected `open_app` → the SAME Settings window + `Opening Settings`. Screenshot `f119-typed-open-settings.jpeg`.
- **S-27 PASS.** 4 captures uploaded via `upload-evidence --issue 2903`; the report references `telemetry_spans` (16,401 rows, newest `2026-09-20T02:00:18.633Z`) + the `fredo emit` marker rows.

## #2904 extension — mode-parity clean render quick path

> Issue #2904 fixes a stray vertically-stacked `Fredo…` string in the launcher search bar while
> dictating. Quick path only — the full matrix lives in `functional.md` F-127 / `regression.md`
> R-41 and `launcher` F-101..F-107. **Verification policy: live.**

- [ ] S-28: **Both modes dictate a clean one-line indicator.** Select `Local transcription`
      (`companion-voice-handling-select`), drive a launcher-origin capture on the empty focused bar,
      screenshot + run the `launcher` #2904 Shared probe; then select `Model audio` (applies to the
      next session) and repeat.
  **Expected:** in EACH mode the indicator is on ONE line (local `Listening`/`Listening…` + `release
      Space to finish` hint; model `Fredo is listening` + `release Space to finish` placeholder, hint
      chip suppressed — the #2904 AC2 relocation), with NO `verticalWrap`/`narrow` node and an
      empty `overlapField`; the mode persisted; screenshot succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.

### #2904 testing round 1 (spec/2904 @ 027bbf1f) — result

- **S-28 PASS (live).** Local then model, via the shipped `companion-voice-handling-select` (mode persisted `model`): each mode's indicator rendered on ONE line (local `Listening` + `Listening…` + `release Space to finish` hint; model `Fredo is listening` + `release Space to finish` placeholder, hint suppressed); no `verticalWrap`/`narrow` node; content-box overlap 0; screenshots succeeded; console error-level empty. Evidence: `.opencode/tmp/2904/tests-runs.md` / `## Tests Runs (round 1)`.

## #2914 extension — model-audio-only quick paths (the local mode is gone)

> Issue #2914 deletes the local STT engine + the mode. Quick paths only — the full matrix lives in
> `functional.md` F-128..F-142 / `regression.md` R-42..R-47 / `exploratory.md` E-67..E-72.
> **Verification policy: live.** Serving checkout: the `spec/2914` tip (fill the SHA per round).
> **SUPERSESSION:** **S-10** (the `sttModel` model step) and **S-20** (the mode selector, default
> `local`) are **RETIRED** — the model step and the mode control must not exist; **S-28's LOCAL half**
> is **RETIRED** (the MODEL half survives as S-30). **S-4** (settings has no voice section) remains a
> historical spike annotation, not re-run.
> **Levers (from `functional.md`):** L1 real hold-Space gesture · L2 real control plane
> (`stt_start|stop|cancel|status|warm|release`, `stt_take_audio_clip`, `llm_chat_with_audio`,
> `stt_audio_capability`) · L3 synthetic `stt:state` (state only) · L4 `FREDO_STT_FEED_WAV` in-repo
> feed (`dev-env.ps1 -EnvVar NAME=value`). **`stt:transcript` is RETIRED.** No out-of-repo asset (G-172).

- [ ] S-29: **Settings → Companion voice group has NO STT row.** Open the Settings app window →
      Companion (ready branch); enumerate `[data-testid^="companion-voice-"]` + nav/section titles.
  **Expected:** the enable toggle + `companion-voice-device-select` + the model-audio controls render;
      `companion-voice-model-row` / `-model-download` / `companion-voice-handling-select` /
      `companion-voice-model-audio-use-local` are ABSENT; no "Voice"/"Local transcription"/"sherpa"
      text; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-30: **Model-audio listening quick path (no transcript).** Hold Space (L1) on the EMPTY focused
      bar; sample the chip; release.
  **Expected:** `Fredo is listening` (`launcher-command-model-listening-chip`) present for the capture
      with ZERO dictated words anywhere; release → processing → chip clears on `llm-done`; `stt_status.listening`
      `true` → `false`; screenshot succeeds; console clean. **If the model-audio capability is
      unavailable → assert the typed non-local remediation instead — never a fabricated delivery.**
- [ ] S-31: **Wizard has no STT step.** Open `companion-setup-wizard`; enumerate steps + Optional group.
  **Expected:** no `companion-step-stt-model`; the gating summary unchanged; screenshot succeeds.
- [ ] S-32: **Build-footprint quick check.** Read `apps/tauri/src-tauri/Cargo.toml` (+ `Cargo.lock`) and
      grep the source for `sherpa_onnx` / `SherpaRecognizer` / `STT_SUBDIR` / `download_stt_model`.
  **Expected:** ZERO sherpa entries/symbols; no `SHERPA_ONNX_LIB_DIR` note; the default build needs no
      native-archive fetch. Record the CI `rust-validate` result (the tester shell has no `cargo`).
- [ ] S-33: **Cleanup quick path (no-op).** Boot with NO sherpa STT dir; then boot with a seeded one.
  **Expected:** both boots succeed; the absent case is a silent no-op; the present case removes only the
      STT dir and touches nothing else; the voice feature stays usable.
- [ ] S-34: **Evidence + telemetry receipt.** A capture from S-29/S-30 is uploaded via
      `upload-evidence --issue 2914`, the raw URL resolves, and it is embedded in `## Tests Runs` with a
      textual description; the body also references `telemetry_spans` (non-zero, recent
      `max(ingested_at)`).

### #2914 run log

- [ ] _(pending — the Tester appends the smoke results; do not pre-fill)_
