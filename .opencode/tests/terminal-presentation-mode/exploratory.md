# Exploratory — terminal-presentation-mode

> Feature #2947. Unscripted probes for edge/failure states not covered by the
> functional rows. A confirmed finding **promotes** to `functional.md` as a new
> `F-` row (keep the origin note). Leave `- [ ]` while unconfirmed.

## Seeded probes

- [ ] **E-1 — mode flip while a session is `starting`.**
  Toggle the mode in Settings while a session is mid-spawn; observe whether the
  session still lands and whether a window/process orphans.
  Expected: no orphan; the session either lands in the new mode or is cleanly ended.

- [ ] **E-2 — mode flip while a native `terminal` window is still open.**
  new-window with the window open → select same-window → open Terminal.
  Expected: per UI/UX §2 the already-open window is LEFT ALONE (not re-parented,
  closed, or duplicated); the NEXT open honours the new mode; no extra window and
  no orphan.

- [ ] **E-3 — `fredo open-terminal` race with a manual mode change.**
  Fire the CLI at the same moment the mode is saved.
  Expected: deterministic single open in one mode; no duplicate window/session.

- [ ] **E-4 — corrupt storage shapes.**
  Store `null`, `"Same-Window"`, `" same-window "`, and a JSON array under
  `terminal_presentation_mode`; restart each time.
  Expected: default `new-window`, no crash, no console error.

- [ ] **E-5 — rapid repeated entry-point clicks.**
  Click the toolbar entry point several times quickly in each mode.
  Expected: the module-level in-flight guard holds; one window/session, no
  duplicate.

- [ ] **E-6 — window resize / layout in same-window mode.**
  Resize the main window with Terminal docked as an in-window app; check the Ghostty
  canvas re-fits and the PTY grid tracks (no clipped/blank terminal).
  Expected: `resize_pty` fires; pane fills; output remains readable.

- [ ] **E-7 — dark/light theme swap with Terminal in same-window mode.**
  Toggle the theme while Terminal is docked inside the main window.
  Expected: all Terminal chrome re-tints from tokens; no hardcoded colour remnant;
  no re-render loop in the console.

- [ ] **E-8 — resume a previous record after a mode round-trip.**
  Resume a record, flip modes twice, resume again.
  Expected: record identity preserved; no duplicate record; no orphaned PTY.

## Prompts (unscripted)

- Probe any state where the mode control and the launcher/toolbar disagree.
- Probe window-focus behaviour when both `main` and (stale) `terminal` exist.
- Probe the CLI with `--dir` values containing spaces/quotes and relative paths.
- Probe a mode flip from every entry point (app directory, toolbar, CLI) in turn.
