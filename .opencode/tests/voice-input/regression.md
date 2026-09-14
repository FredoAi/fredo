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
