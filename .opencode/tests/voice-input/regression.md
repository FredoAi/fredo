# Voice Input — Regression

> The "must not change" baseline for the STT spike (#2876). The POC adds a listening path but
> must not disturb the existing launcher/command-bar/Ctrl+Space behavior it rides on. Runs on a
> running Fredo POC on `spec/2876`. **Verification policy: live.**
>
> **Overlapping suites to run alongside:** `launcher` (the command-bar input, #2819/#2823
> Ctrl+Space keyboard slice, #2871 smart-Enter), `desktop-chrome` (#2823 R-12/R-20 Ctrl+Space
> toggle invariants), `companion` (companion seat/active state that feeds branch (1) of the
> context-dependent activation).

## R-1 — Existing launcher bar input behavior unchanged

- [ ] R-1: With the POC's listening path OFF, type into `input[role="searchbox"]`
      (`LauncherCommandBar.tsx:133`): the controlled value updates per keystroke, the grid filters,
      clearing restores the grid, ESC closes the launcher. The bar is byte-identical to before the
      POC change when the POC flag is off (no placeholder swap, no border tint, no reserved
      padding). **Expected:** no behavioral or visual drift; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## R-2 — #2823 Ctrl+Space toggle unchanged

- [ ] R-2: The #2823 Ctrl+Space toggle still opens + focuses the searchbox, ESC closes, and focus
      restores to the pre-open element. **Expected:** intact. **Note:** a synthetic Ctrl+Space
      keypress may not land focus in automation (OS/WebView2 IME gate — `launcher` F-19 edge,
      `desktop-chrome` R-12/R-20); if so, verify via the notch/focus path + record the blocker.
      Reference `launcher` R-20 / `desktop-chrome` R-12.

## R-3 — Rapid Ctrl+Space double-press idempotent

- [ ] R-3: Press Ctrl+Space rapidly (≥5× fast) — the launcher toggles cleanly each press (no stuck
      state, no focus bounce, no double-toggle, no console error). **Expected:** `launcher` E-11
      behavior intact.

## R-4 — ESC / close precedence unchanged

- [ ] R-4: ESC closes a shortcut-opened launcher and restores focus; with a feature window open
      behind, ESC precedence is unchanged (`launcher` E-15). **Expected:** no double-close, no
      focus-chatter introduced by the listening path.

## R-5 — App boots with no audio capture

- [ ] R-5: Launch Fredo with NO microphone / permission denied — the app still boots to the
      desktop with the launcher bar rendered; no crash, no console `Error:`/`Uncaught`, no
      blocking modal. **Expected:** audio is opportunistic, never a boot dependency.

## R-6 — No new remote surface at rest

- [ ] R-6: With the POC idle (not listening), the app makes no new outbound network connections
      and the STT path opens no remote endpoint. **Expected:** local-only holds at rest; any model
      download is user/setup-gated, never automatic during transcription.

## R-7 — Existing type-check / CI baseline

- [ ] R-7: `pnpm --filter @fredo/ui build` remains clean and `cargo check` on the
      `apps/tauri/src-tauri` crate remains zero-warning for pre-existing code. **Expected:** the
      POC introduces no new TS or Rust diagnostics.

## R-8 — Settings surface untouched (no autosend section)

- [ ] R-8: The settings dialog (`ProfileSettingsModal.tsx`) gains NO voice/STT/autosend section in
      this spike (autosend is explicitly NOT built). **Expected:** the settings nav is unchanged;
      do NOT test a section that does not exist.

## Promoted regression findings

> Findings that become durable regression invariants are recorded here with their origin note.

- **R-9 (promoted, round 1):** `stt_start` with a **size-valid / content-invalid** model must NOT hang or abort the app — it must return a typed code and leave the process responsive. Origin: `functional.md` F-15 / `exploratory.md` E-15.

## Run log — round 1 (2026-09-14, `spec/2876` @ `df47d4f`)

- **R-1 PASS** — bar typed/controlled normally; cue off (`placeholder="search or command"`, plain border class) when not listening.
- **R-2 PARTIAL** — Ctrl+Space branch (2) live (open+focus bar → listening). Branch (3)/carve-out not driven live (see functional run log); pure `selectCtrlSpaceAction` unit-pinned (13 tests).
- **R-3 UNVERIFIED** — rapid double-press not driven live (automation key/focus limitation, launcher F-19 / desktop-chrome R-12/R-20); `selectCtrlSpaceAction` unit-pinned.
- **R-4 PASS** — Escape cancelled the session and left the bar open with the transcript; ESC-on-open close behavior untouched (code review + live cancel).
- **R-5 PASS** — app booted and ran with the virtual/silent capture device; no crash, no blocking modal.
- **R-6 PASS (static)** — no new remote surface at rest; voice module has zero remote clients; model download is setup-gated only.
- **R-7 PASS** — `pnpm --filter @fredo/ui build` clean; `cargo clippy --locked -D warnings` zero warnings; `cargo test --locked` ST-6a 10/10.
- **R-8 PASS** — Settings nav unchanged; no voice/STT/autosend section added (voice group lives in Companion).

## Run log — round 2 (2026-09-14, `spec/2876` @ `84ff1ac`, fix `d9a9f8d`)

- **R-9 PASS (live, promoted round 1)** — a size-valid / content-invalid encoder now returns typed `modelCorrupt` (SHA gate, 2073 ms) with the app responsive; no bridge drop, no native abort (`STATUS_STACK_BUFFER_OVERRUN` / `0xc0000409` zero hits), and the normal start/stop path still works after restore. See `functional.md` round-2 F-15.
- **R-1 PASS (regression)** — the bar is controlled normally (`placeholder="search or command"`, plain input) when not listening; the DR-1 cue appears only while `listening`.
- **R-4 PASS (regression)** — `stt_cancel` discarded the in-flight partial and left the bar in place (`value=""`, resting placeholder); Escape keypress accepted.
- **R-5 PASS (regression)** — app booted and stayed alive with the silent virtual device through all legs (6 `stt_start`/`stop` cycles, 4 failure-mode perturbations).
- **R-6 PASS (static)** — unchanged; no remote client on the audio→text path.
- **R-7 PASS (regression)** — `cargo test --locked` 502 passed / 1 ignored; `cargo clippy --locked -- -D warnings` zero warnings; `pnpm --filter @fredo/ui build` N/A (no UI file touched by the fix).
- **R-2/R-3/R-8** — unchanged from round 1 (Ctrl+Space focus automation limit / settings not re-driven); see round-1 notes.

---

## #2877 extension — the local STT foundation must not regress the surfaces it rides on

> Added at Spec #2877. Run alongside R-1..R-9 above and the overlapping suites listed in
> §"Overlapping prior-feature suites". **Verification policy: live** (the tester's Evidence must
> carry the functional F-37 live receipt). Historical PASS/FAIL records above are preserved.
>
> **SUPERSESSION (from #2877):** R-8 ("the settings dialog gains NO voice/STT/autosend section in
> this spike") is **SUPERSEDED** by the PO amendment — voice/STT settings (enable, model status,
> device, autosend) now live INSIDE the Companion settings section, hosted in the Settings app
> window (`SettingsSurface.tsx` → `CompanionSettingsPanel`). Do NOT re-run the old "no voice
> section" assertion as a FAIL; the new invariant is R-16 below.
> **MOVED to #2878:** this file's R-2/R-3 (Ctrl+Space live-driving limits) and the functional F-9/
> F-10 bar-input rows are #2878's surface cascade — NOT re-run as FAIL here. Only the disabled-chord
> gate (functional F-18) stays in this spec.

## R-10 — Launcher / command-bar / Ctrl+Space behavior unchanged when voice is off

- [ ] R-10: With voice OFF (or not listening), type into `input[role="searchbox"]` (`LauncherCommandBar.tsx`): the controlled value updates per keystroke, the grid filters, clearing restores the grid, ESC closes the launcher. Press Ctrl+Space in the launcher context with voice disabled: the #2823 show/focus behavior still fires and NO listening starts.
  **Expected:** no behavioral drift and no listening cue while not listening (the cue appears only while `listening`); console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`. Reference functional F-18/F-31.
  - **Edge:** rapid Ctrl+Space double-press (no stuck state, no double-toggle); ESC precedence unchanged with a feature window behind; the bar is byte-identical to before the spec when voice is off.

## R-11 — Disabled-chord gate is the only Ctrl+Space change (surface cascade is #2878)

- [ ] R-11: With `Fredo_companion_voice_enabled=false`, invoke Ctrl+Space from each context (companion active; bar focused) and assert the launcher's #2823 behavior executes without starting a session.
  **Expected:** zero `stt_start` invocations while disabled; the launcher open/focus behavior is unchanged from R-2; the companion-away/companion-listening cascade is NOT asserted here (#2878 owns it).
  - **Edge:** synthetic Ctrl+Space may not land focus under automation (R-2/R-3 note) → drive the disabled gate via the direct `stt_start` invoke + the unit-pinned chord selection; record the lever.

## R-12 — The download engine + companion GGUF layout are untouched

- [ ] R-12: Exercise the `llama-setup` model-files surface (per-file rows, skip-present, Range resume, per-file error isolation) and the companion model readiness; compare against `.opencode/tests/llama-setup/` R-8..R-15 + R-30.
  **Expected:** `download_missing_files` semantics unchanged; the companion GGUF manifest/subdir/layout (`gemma-4-e2b-it-qat` + nested `MTP/`) untouched; the new `sttModel` step is ADDITIVE and non-gating (counts stay GGUF-only). Reference `.opencode/tests/llama-setup/` R-30.
  - **Edge:** a companion GGUF download and an STT download must not corrupt each other's progress/state; `models_dir` resolution order unchanged.

## R-13 — Companion overlay behavior + persisted keys unchanged by the voice group

- [ ] R-13: Toggle the companion ON/OFF; exercise single-click joke, double-click TicTacToe, Ctrl+right-click teleport, and the speech bubble; read `Fredo_companion_visible` / `Fredo_companion_idle_timeout`; confirm `isAway` is not persisted.
  **Expected:** `.opencode/tests/companion/` R-33..R-38 still hold — teleport timing, the 250 ms discriminator, 240×120 / 208×268 bubbles, the `above > right > left > below` ranking, and the persisted-key semantics are unchanged; the voice group adds its own keys and does NOT mutate the existing ones.
  - **Edge:** the voice group's rows render inside the ready-state Companion section without removing the toggle/teleport tip; the not-ready gate (`R-31`) still renders the wizard ONLY with the optional `sttModel` row additive.

## R-14 — Settings host unchanged (no orphan Voice nav item/section)

- [ ] R-14: Open the Settings app window; enumerate its nav items/sections and its discovered feature sections; open Companion.
  **Expected:** no new nav item and no dedicated "Voice" section was added anywhere; the Companion section mounts cleanly with the voice group additive; a settings-section list with zero discovered sections does not break. Reference `.opencode/tests/settings/` host rows + `companion` R-31/R-32.
  - **Edge:** open/close the Settings window while listening; the voice group's presence does not disturb the readiness gate swap.

## R-15 — Token contract + build gates unchanged

- [ ] R-15: Static-grep the changed voice/settings files for hex `#…`, `rgba(`, `rgb(`, `hsla(` and the invalid `var(--x)NN` alpha-append; run `pnpm --filter @fredo/ui build` + `pnpm --filter @fredo/ui test:run`; run the Rust gates (or record the CI result — the tester shell has no `cargo`).
  **Expected:** ZERO true color literals (comment issue-refs exempt); theme token → CSS var + `tint()` only; build exit 0; suites green; `cargo check`/`clippy` zero warnings and `cargo test` green; no existing assertion weakened/disabled/deleted (G-125).
  - **Edge:** a moved/renamed frozen hook must be refreshed in the same scope and named; a silently dropped hook is a FAIL.

## R-16 — Voice settings live under Companion, hosted in the Settings window (supersedes R-8)

- [ ] R-16: Open the Settings app window → Companion; assert the voice group (enable toggle + model status + device + autosend) renders inside the Companion section and that enabling/disabling persists `Fredo_companion_voice_enabled`.
  **Expected:** the voice settings are discoverable through the settings surface inside Companion (no dedicated Voice section/nav); toggling persists; the not-ready gate still renders the wizard first, with the voice row additive; on ready the controls include the voice group. **This row REPLACES R-8's "no voice section" invariant** (kept above as history).
  - **Edge:** legacy `R-8` re-run must not be reported as a FAIL; the gate → controls swap still happens in place with no reload (`.opencode/tests/companion/` R-31/R-32).

## R-17 — No idle CPU / no undeclared persisted key

- [ ] R-17: Launch Fredo and leave it idle (never listening); sample CPU + assert no recognizer was constructed; enumerate newly persisted keys after enabling/disabling voice, choosing a device, and toggling autosend.
  **Expected:** no measurable idle CPU while not listening (engine created lazily on first `stt_start`); the only new persisted keys are the declared voice preferences (`Fredo_companion_voice_enabled`, the device id, the autosend value); no existing companion key is rewritten by the voice group.
  - **Edge:** enable → restart → disable leaves the declared keys consistent and the existing companion keys intact.

## Run log — #2877 round 1 (2026-09-15, `spec/2877` @ `dbb3843`)

- **R-10 PASS** — with voice off/not-listening the bar is controlled normally (`placeholder="search or command"`, no listening cue); a live Ctrl+Space with voice DISABLED opened/focused the bar (#2823 behavior) and did NOT start listening; console clean.
- **R-11 PASS** — disabled-chord gate driven via BOTH levers (real Ctrl+Space → `open`, no `stt_start`; direct invoke → `{code:"disabled"}`); zero sessions while disabled.
- **R-12 PASS** — `download_stt_model` reuse of `download_missing_files` unchanged: skip-present by exact size (`skipped` ×4), streamed SHA-256 verify (the MS-V3 garbage encoder was rejected with the expected/got digests), Range resume from the persisted offset; the companion GGUF manifest/`models_dir` resolution untouched (the real `models` dir was restored after every scratch-seam leg).
- **R-13 PASS** — the companion toggles/teleport/bubble were not disturbed by the voice group; the voice group added only the declared keys (`Fredo_companion_voice_enabled`, `Fredo_companion_voice_autosend`, `Fredo_companion_voice_device_id`) and left the existing companion keys intact.
- **R-14 PASS** — Settings nav enumerated (no orphan Voice item/section); the Companion section mounts cleanly with the voice group additive; the not-ready gate still renders the wizard first (observed on a fresh app start) with the optional `sttModel` row additive.
- **R-15 PASS** — `pnpm --filter @fredo/ui build` + `test:run` (79 files / 1036 tests) + `pnpm --filter @fredo/tauri build:webview` all clean; Rust gates recorded from CI (`rust-validate` PASS: check + nextest + clippy `-D warnings`) — the tester shell has no `cargo`. Frozen hooks (`companion-controls`, `companion-voice-model-download`, `companion-step-stt-model`, `companion-setup-optional`, `launcher-command-listening`) all present.
- **R-16 PASS** — voice settings live under Companion inside the Settings window; enable/disable persists `Fredo_companion_voice_enabled`; the historical `R-8` "no voice section" assertion was NOT re-run as a FAIL (superseded).
- **R-17 PASS (measured)** — idle CPU while not listening: 0.78 s CPU / 10.30 s wall = **0.76 %** (baseline app, no recognizer constructed). Newly persisted keys after the legs = the three declared voice preferences only; the existing companion keys were untouched.

## Run log — #2877 round 2 (2026-09-15, `spec/2877` @ `1920ae43`)

Scope: the F-38 fix surface only (`session.rs` state emission + `useVoiceDictation.start()`). The full R-10..R-17 matrix was NOT re-run — round-1 evidence stands for the untouched rows.

- **R-10 PASS (regression, partial).** At idle the bar is byte-behavioural as before: `placeholder="search or command"`, no listening cue, no bubble, `stt_status {listening:false}`. With voice enabled + companion away, Ctrl+Space correctly took the companion-listen branch (never the bar) — consistent with R-16/DR-9.
- **R-16 PASS (regression, live).** Settings → Companion ready branch still renders the voice group inside `companion-controls` (enable checked + model installed/location + device + autosend), no Voice nav item/section added; the not-ready gate still renders the wizard with the optional `sttModel` step additive. Evidence: `r2-regression-voice-settings.jpeg`.
- **R-17 PASS (regression, measured).** Idle WS 87.2 MB with no recognizer constructed (engine loads only on `stt_start`: 208.9 MB listening → 88.0 MB after stop).

---

## #2882 extension — the trigger changed, the surfaces it rides on must not (G-136)

> Issue #2882 retires the Ctrl+Space listening cascade and moves dictation to HOLD SPACE in the
> focused empty search bar; transcripts become Fredo-only. **G-136 SUPERSESSION (history preserved):**
> - **R-2 / R-3 / R-11** pinned the #2823 Ctrl+Space TOGGLE and the context cascade. **EXTENDED /
>   SUPERSEDED:** Ctrl+Space now ALWAYS shows + focuses the bar, never starts or stops listening and
>   never closes the bar. The `companion-away` ⇒ `companion-listen` branch and the bar-focused
>   `launcher-listen`/`launcher-cancel` branches are RETIRED (their R-2/R-11 records stand as history;
>   do NOT re-run them as PASS or FAIL).
> - **R-8's** "no voice/STT/autosend section" supersession (from #2877) stands; **R-16/R-17** remain in
>   force unchanged (voice settings live under Companion; no idle CPU / no undeclared persisted key).
> Run alongside R-1..R-17, the `launcher` R-40..R-43 extension and the `companion` R-39..R-41
> extension. **Verification policy: live.**

## R-18 — The spaces that are TEXT still land; the interface stays usable while dictating

- [ ] R-18: With voice enabled and NOT listening, type into `input[role="searchbox"]` (including
      spaces) — the controlled value updates per keystroke, the grid filters, clearing restores the
      grid, ESC closes the launcher (R-1 unchanged; the LIVE-TEXT/editable-while-listening behavior
      of the retired F-41/F-39 rows stays in force for a hold session).
  **Expected:** no behavioral drift when not listening; the bar is controlled normally and every typed
      space lands; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## R-19 — Ctrl+Space never starts/stops listening in ANY context; nothing else broke

- [ ] R-19: With voice ENABLED and again with it DISABLED, press Ctrl+Space from (a) the resting
      desktop, (b) the companion AWAY, (c) the bar already focused, (d) mid-reply. Subscribe to
      `stt:state`.
  **Expected:** ZERO `stt_start`/listening emissions in EVERY context (the retired cascade is gone);
      the bar shows + focuses each time; the 2nd press does NOT close it; the disabled case is
      indistinguishable from the enabled case for the chord (the DR-9 gate is now vacuous for the
      chord but must not break it). Reference R-2/R-11 (superseded half) + `launcher` R-42.
  - **Edge:** synthetic Ctrl+Space may not land focus under automation (R-2/R-3 note) → drive via
    the notch/focus path + the direct `stt_start` invoke and RECORD the lever; never a silent PASS.

## R-20 — Download engine / companion GGUF / settings / token + build gates unchanged

- [ ] R-20: Re-run the untouched-surface checks: `download_missing_files` semantics (skip-present by
      exact size, streamed SHA-256, Range resume — R-12); the companion GGUF manifest/`models_dir`
      layout + the non-gating `sttModel` step (R-12); the Companion settings host with no orphan
      "Voice" nav item/section (R-14/R-16); the token contract + `pnpm --filter @fredo/ui build` /
      `test:run` / `pnpm --filter @fredo/tauri build:webview` and the Rust gates (CI) (R-15).
  **Expected:** all unchanged; ZERO true color literals / no `var(--x)NN` alpha-append in the changed
      files; NO existing assertion weakened, disabled or deleted (G-125) — a moved/renamed frozen hook
      is refreshed in the same scope and named.

---

## #2887 extension — the faster trigger must not move the #2882 contract (G-136)

> Issue #2887 removes the "not yet listening" wait (the recognizer is kept ready/resident while Fredo
> is idle — PO amendment 1) and makes the indicator honest. **G-136 SUPERSESSION (history preserved):**
> nothing in #2887 retires a prior row — this extension re-asserts the #2882 hold/release contract and
> the #2877 privacy/lifecycle invariants against the faster/resident arming. R-1..R-20 remain in force.
> Run alongside R-21..R-24, `launcher` R-50..R-53, and the new `functional.md` F-74..F-82.
> **Verification policy: live.**

## R-21 — The #2882 hold/tap/non-empty/voice-off contract is UNCHANGED

- [ ] R-21: Re-run `functional.md` F-66 (hold dictates; listening ONLY while held; release finishes;
      sub-threshold TAP and never-live hold each land exactly ONE ordinary space with ZERO `stt_start`
      and the mic never opened), F-67 (Space in a NON-EMPTY field is a literal space — zero lost or
      converted spaces; the empty-bar TAP is one too), F-68 (voice disabled / model absent → ordinary
      space, no capture attempt, no error, no `role="alert"`), F-73 (mic never left hot; blur keeps
      the words) and `launcher` F-64..F-69 on the #2887 tip.
  **Expected:** byte-for-byte the shipped #2882 outcomes — ZERO regressions. The faster/resident
      arming changes nothing observable in these rows; over the whole leg a confirmed LOST or
      CONVERTED space FAILs the round (G-158). **Do not assert a specific readying affordance or a
      changed short-hold threshold (open items (a)/(b)) — assert only these observable outcomes.**
  - **Edge:** voice disabled MID-hold; the model removed between probe and hold; a hold whose release
    lands exactly at the 200 ms threshold; a tap right after a cleared dictated transcript; a hold
    immediately after a cancelled hold.
  - **Receipt:** the per-leg `value`/`stt_start` count/cue state/`role="alert"` presence.

## R-22 — Transcript routing + exactly-once dispatch unchanged

- [ ] R-22: Re-run `functional.md` F-69/F-70 (a dictated transcript is ALWAYS Fredo's, even edited;
      no dictated phrase ever opens an app) + F-51/F-52/F-53 (one dispatch per finalize, N finals +
      one release = ONE dispatch, no phantom dispatch on a silent session) on the #2887 tip.
  **Expected:** exactly ONE dispatch per dictated turn; ZERO windows from dictated content; the hint
      reads `↵ send transcript to Fredo`; the faster arming introduces no second commit path (no
      duplicate finalize, no commit of a pre-session draft).
  - **Edge:** a final landing after the `listening:false` state event; a duplicate `stt_start`
    (`alreadyListening`) during a fast re-arm; clear-to-empty then a hold.

## R-23 — Privacy + the mic-release invariant under the resident lifecycle

- [ ] R-23: With the resident readiness active (nothing dictated), subscribe to `stt:state` and watch
      for any capture start / mic-in-use indicator / working-set rise; then hold, release, and cancel.
      Re-assert `functional.md` F-71/F-79 + F-31 cue routing.
  **Expected:** NO capture and NO mic open while merely resident-ready at idle; the visible indicator
      is present for the WHOLE capture and cleared on release/cancel with no gap; the mic is released
      on release/cancel (`stt_status.listening === false`, working set back to the resident baseline);
      exactly one indicator per origin. A capture without a visible indicator FAILs the round (G-158).
  - **Edge:** the resident-ready state held across the declared idle window; disable voice while
    listening; release before the session goes live; a never-live hold (mic never opened).

## R-24 — Idle resource + persisted-key invariants extended to the resident

- [ ] R-24: Extend R-17: with the resident readiness active and the app idle, measure CPU (Get-Process
      CPU delta over ≥10 s) and working set at t0 and at the END of the declared idle window; enumerate
      newly persisted keys; sample the console.
  **Expected:** idle CPU ≤ the plan's bound (default ≤ 1 % avg / 10 s); working set within the
      resident budget (default Δ ≤ 350 MB); only declared persisted keys; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`; no polling loop / no effect depending on an
      array `.length` or a freshly-created object (AGENTS.md #523). Reference R-17.
  - **Edge:** enable → restart → idle → hold leaves the declared keys consistent; the resident must
    not rewrite an existing companion/voice key.

---

## Run log — #2887 round 2 (2026-09-18, `spec/2887` @ `ff5962a1`)

Scope: the F2 join + F1 derivation surface re-test (round-1 FAILs: REQ-4B not-resident path, REQ-8
resident-idle cost) plus a regression sweep, all live on the repo-root-served app
(`dev-env.ps1 -Action Up -Spec 2887`). App held `spec/2887 @ ff5962a1` for every live leg.

- **R-21 PASS (regression, live).** Tap (100 ms) → exactly ONE ordinary space, ZERO `stt:state` (the
  mic was never opened), keydown consumed. Non-empty bar → the app does NOT consume the keydown
  (`defaultPrevented=false`), ZERO capture events, no error. (The literal space *insertion* on a
  non-empty bar is not observable with a synthetic key lever — recorded, not scored as FAIL.)
- **R-22 PASS (regression, partial, live).** Dictated `Settings` with autosend OFF: the bar shows the
  transcript, exactly ONE final, the hint `↵ send transcript to Fredo`, nothing dispatched → no app
  opened. The autosend-ON dispatch legs were NOT re-driven in round 2 (the routing code is outside
  the F2/F1 fixed surface).
- **R-23 PASS (regression, live).** Cue sampled at 20 ms across each hold: ZERO pre-capture listening
  cues (`cuesBeforeLive: 0` in every sampled hold); placeholder sequence
  `search, or hold Space to dictate` → `Hold to dictate…` → `Listening…` only after
  `stt:state{listening:true}`. 3 mid-hold cancels (2 × Escape, 1 × the live `×` control) →
  `listening:false`, no space, no stuck cue.
- **R-24 PASS (regression, measured).** Engine-attributable idle CPU = **0.000 %** of one core (the
  round-2 binding scoring method): engine-absent **1.322 %** (CPU Δ 0.7969 s / wall 60.273 s) vs
  resident-idle **1.322 %** (0.7969 s / 60.26 s) — same host, same run, two independent 60 s windows,
  both absolutes disclosed; a 240 s resident window read **1.21 %** (2.9063 s / 240.262 s). WS 93.9 MB
  engine-absent → 210.7 MB resident = **RSS Δ +116.8 MB** ≤ 350. Residency survived 321.1 s idle
  (`stt_warm` → `warmMs:null` = no reload); after `stt_release` the next hold recovered in
  **5034.2 ms** (`readyMs` 4826, `engineResident:false`) with a typed state and no stuck cue. No new
  persisted key.

### #2887 AC4 latencies re-measured on `ff5962a1`

- Warm, 10 resident holds (400 ms): **p50 214.6 / p95 223.0 / max 223.0 ms** (`readyMs` 9–14 ms),
  `engineResident:true` 10/10, exactly one `stt_start` per hold.
- Cold-idle (321.1 s, engine resident): **245.2 ms** (`readyMs` 40, `engineResident:true`);
  cold−warm delta **+22.2 ms** ≤ 50.
- AC4B not-resident path: self-start **5034.2 ms** (`readyMs` 4826); single-flight join
  **4858.2 ms** (`readyMs` 4650) with a concurrent `stt_warm` `warmMs` **4840** — the hold went live
  18 ms after the single load, i.e. it joined instead of paying a second load. Both ≤
  `T_LAUNCH_COLD_MAX_MS` 5320.
- Fresh launch (`Up -Spec 2887`): the FIRST hold was **253.4 ms** (`readyMs` 25,
  `engineResident:true`) — no hold landed in the launch window on this host.

### Levers added / confirmed (durable)

- **Single-flight join lever:** `stt_release` (drop the resident engine) → immediately `stt_warm` ∥ a
  Space hold → the hold must JOIN the one load (`engineResident:false`, live ≈ the load's remaining
  time); a duplicate load would show ≈ 2× the load before capture.
- **Engine-attributable CPU method:** two independent ≥60 s windows on the SAME host/run —
  `stt_release` (engine-absent) then `stt_warm` (resident-idle) — scored on the DELTA with both
  absolutes disclosed; `bun .opencode/tmp/<N>/cpu-window.mjs <secs> fredo` supplies both.
- **Launch-window ladder:** after `Up`, connect the bridge FIRST (trivial `execute_js`), then read
  `performance.timeOrigin` / `performance.now()` at the first probe and `stt_warm().warmMs`
  (`null` ⇒ already resident). A precise first-interactive-frame → resident interval needs a
  pre-injected frontend probe (named blocker).
- **Cold-idle discipline:** the AC4A cohort needs ≥300 s (`COLD_IDLE_WINDOW_MS`) with NO capture
  since the previous session END, engine resident — verify `stt_warm` → `warmMs:null` immediately
  before the hold.
- **Tooling notes:** `dev-env.ps1 -Action Restart` is broken (forwards `Spec=0` → `ValidateRange`
  error) and leaves the app DOWN — use `Down` + `Up -Spec <N>`; `Up` now requires `-Spec <N>`; the
  MCP script-result channel times out for scripts running ≳5 s (drive long legs fire-and-forget and
  read the result back from a page probe).

---

## #2888 extension — the casing/name change must not move any surface it rides on (G-136)

> Issue #2888 normalizes the dictated transcript (sentence case + intentional capitals + the name
> `Fredo`) and does not change the trigger, the routing or the privacy invariants. **G-136
> SUPERSESSION (history preserved):** nothing here retires a prior row — this extension re-asserts
> the #2882 hold/release contract, the #2887 resident-indicator/latency contract and the
> #2883/#2886 bar/reply surfaces against the normalized transcript. R-1..R-24 remain in force.
> Run alongside R-25..R-29, `functional.md` F-83..F-101, and `launcher` R-50..R-53 / F-82..F-84.
> **Verification policy: live.** The full row set is in the QA Plan (`REQ-1..REQ-9`, `NFR-1..NFR-3`)
> — these are the no-change baselines.

## R-25 — The #2882 hold/tap/non-empty/voice-off contract is UNCHANGED

- [ ] R-25: Re-run `functional.md` F-90 (hold dictates; listening ONLY while held; release finishes;
      sub-threshold TAP and never-live hold each land exactly ONE ordinary space with ZERO `stt_start`
      and the mic never opened), F-91 (Space in a NON-EMPTY field is a literal space — zero lost or
      converted spaces), F-92 (voice disabled / model absent ⇒ ordinary space, no capture attempt, no
      error, no `role="alert"`) and F-93 (mic never left hot) on the #2888 tip.
  **Expected:** byte-for-byte the shipped #2882/#2887 outcomes — ZERO regressions. Over the whole leg a
      confirmed LOST or CONVERTED space FAILs the round (G-158).
  - **Edge:** voice disabled MID-hold; the model removed between probe and hold; a release exactly at
    the 200 ms threshold; a hold immediately after a cancelled hold; a tap right after a cleared
    dictated transcript.
  - **Receipt:** per leg — the `value`, the `stt_start` count, the cue state, the `role="alert"` presence.
  - **Also run (new behaviour must not disturb the old):** `functional.md` **F-100** (live parity — the
    bar never shows raw ALL-CAPS at any point of a capture; no partial/final re-casing churn) and
    **F-101** (a user edit is never re-cased). These are #2888 behaviour, but they ride on the #2882
    live-write path — a re-casing pass over already-rendered text, or a normalised write clobbering a
    user edit, is a regression of this row as well as a FAIL of theirs.

## R-26 — Transcript routing + exactly-once dispatch UNCHANGED (incl. the name)

- [ ] R-26: Re-run `functional.md` F-94 (a dictated transcript — **including one containing `Fredo`** —
      is ALWAYS Fredo's, even after editing; no dictated phrase ever opens an app; exactly ONE dispatch
      per turn; N finals + one release = ONE dispatch; no phantom dispatch on a silent session) on the
      #2888 tip, plus `launcher` F-64..F-70.
  **Expected:** exactly ONE dispatch per dictated turn; ZERO windows from dictated content; the hint
      reads `↵ send transcript to Fredo`; a dictation whose transcript is the product name behaves
      exactly like any other dictated transcript (a message to Fredo, never a launch and never a
      special case that skips the dispatch).
  - **Edge:** a final landing after the `listening:false` state event; a duplicate `stt_start`
    (`alreadyListening`) during a fast re-arm; clear-to-empty then a hold; the name as the whole
    transcript with autosend ON and OFF (`Fredo` must NOT be treated as an app name).

## R-27 — Privacy + the mic-release invariant under the normalized transcript

- [ ] R-27: Re-run `functional.md` F-93/F-96 + F-31 cue routing: sample the indicator ≤ 50 ms across a
      live hold; confirm the mic is released on release/cancel (`stt_status.listening === false`, the
      working set back to the baseline); confirm NO capture while merely resident-ready at idle.
  **Expected:** the visible indicator is present for the WHOLE capture and cleared on release/cancel
      with no gap; exactly one indicator per session; NO capture outside a hold; a capture without a
      visible indicator FAILs the round (G-158). The normalization is pure text work on the emitted
      event — it must not touch the capture lifecycle.
  - **Edge:** the resident-ready state held across the declared idle window; release before the session
    goes live; 3 release-and-re-hold cycles.

## R-28 — Idle resource + persisted-key invariants (no new key, no latency creep)

- [ ] R-28: Extend R-24: with the resident readiness active and the app idle, measure CPU (Get-Process
      CPU delta over ≥ 10 s) and the working set at t0 and at the end of the idle window; enumerate
      newly persisted keys after the casing/name legs; sample the console.
  **Expected:** idle CPU ≤ the plan's bound; the working set within the resident budget; ONLY declared
      persisted keys (this spec adds NONE — the normalization is not configurable); console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`; no polling loop / no effect depending on an
      array `.length` or a freshly-created object (AGENTS.md #523).
  - **Edge:** enable → restart → idle → hold leaves the declared keys consistent; a long transcript must
    not leave a growing buffer (cross-ref F-95).

## R-29 — #2887 latency + #2883/#2886 bar/reply surfaces UNCHANGED

- [ ] R-29: Re-run the #2887 numbers that the normalization must not perturb: the warm hold
      press→capture-active series (`functional.md` F-74, `launcher` F-82..F-84) and the resident cold
      path (`F-77`), plus the #2883 wrap/growth ladder and the #2886 reply-band placement
      (`launcher` R-44..R-49) with a sentence-cased multi-line transcript in the bar.
  **Expected:** the hold latency budgets and the bar's wrap/cap/`Shift+Enter` geometry are unchanged
      (the normalization runs on the transcript content, never on the capture-start path); the reply
      band's placement/geometry is unchanged; a normalized long transcript wraps at the same bound
      heights (48/68/88/108 px).
  - **Edge:** a 120-word normalized transcript reaching the 108 px cap with internal scroll; the
    normalized text re-measured after an edit; the resident armed with a dictated transcript present.
  - **Receipt:** the latency series + the measured field heights + the reply-band geometry.
