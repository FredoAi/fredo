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
