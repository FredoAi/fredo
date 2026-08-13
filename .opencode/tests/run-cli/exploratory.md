# Run CLI — Exploratory Test Suite

Feature domain: `run-cli`. Unscripted edge/failure probes for Spec #2728 (single-window launch + ghostty-web terminal), extended for Spec #2731 (maomaolabs toolbar desktop-item launch; floating "RUN CLI" button removed).
Run beyond the scripted functional cases. A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

Conventions: ID prefix `E-`. Record expected vs actual; mark `FAIL` with repro if behavior is wrong.

## Probe prompts (from #2728)

- [ ] E-1: **Rapid double-click on "Run CLI".** Two clicks within ~200 ms. Does exactly one window open (single-instance guard), or do two windows appear? Expected per AC1: exactly one; a second window is a FAIL (promotes to F-1).

- [ ] E-2: **Relaunch immediately after auto-close.** Click "Run CLI" the instant the previous session's window closes (F-7). Does the new launch open a fresh single window cleanly, or does a stale/racing window appear? No "already running" false errors expected.

- [ ] E-3: **Window resize mid-session.** Resize the terminal window while a long output is streaming. Does the ghostty surface reflow and the PTY receive a resize (`resize_pty`)? Any scrollback loss or garbled rendering at extreme sizes (min 400×300)?

- [ ] E-4: **Long/continuous output.** A command producing thousands of lines (e.g. a long diff or `ls -R` of a big tree). Does ghostty stay responsive, does output stay complete, does the console stay clean (no `Maximum update depth exceeded`)? Note scrollback behavior.

- [ ] E-5: **Unicode/wide-character output.** Output containing emoji, CJK, and combining characters. Does ghostty render them correctly (no mojibake, no broken wide-char cells)? Compare visually against the pre-spec xterm rendering if receipts exist.

- [ ] E-6: **ANSI color fidelity.** A program emitting 256-color/truecolor ANSI (e.g. opencode TUI itself, `cargo` output). Are colors/backgrounds rendered correctly (TERM=xterm-256color / COLORTERM=truecolor are set in `commands.rs`)? Any color mismatch vs xterm is a cosmetic finding — report.

- [ ] E-7: **Ctrl-C / interrupt.** Send Ctrl-C to an in-progress tool call. Does the interrupt reach the process and the TUI recover to the prompt? Does the window stay healthy?

- [x] E-8: **Work dir with spaces/unicode, and nonexistent dir.** (a) A fixture dir with spaces/unicode — `pwd` must return it exactly. (b) A deleted/nonexistent configured dir — clear launch error (AC5 surface), no hang, main window unaffected. Promotes to F-6/F-8 if behavior confirms. **CONFIRMED (part b)** — Nonexistent dir `C:\NonexistentDir12345` shows "Working directory not found" with Retry/Close. FIX-2 validates cwd before spawn. Promoted to F-8/F-9. Evidence: Spec #2728 round 2.

- [ ] E-9: **External process kill.** Kill the opencode process externally (taskkill/`kill`). Does the window auto-close (AC4) or hang with a stale terminal? Any zombie window or orphaned PTY?

- [ ] E-10: **Long session memory stability.** Keep a session running for an extended period with steady output. No unbounded memory growth in the webview; console clean.

- [ ] E-11: **Main-window interaction during heavy streaming.** While a very long output streams, open/close other features in the main window. Main window must stay responsive (NFR) — any freeze/jank is a FAIL (promotes to F-10).

- [ ] E-12: **Theme surface.** The terminal is a native surface; confirm the terminal window's own chrome/background is legible in both light and dark themes (no hardcoded colors breaking readability; ghostty's own background is acceptable as a terminal surface).

## Probe prompts (added for #2731)

- [x] E-13: **Toolbar item rapid double-click on a running session.** Double-click the Run CLI toolbar desktop item while a session runs. Does a second window appear (FAIL — promotes to F-19), or is the existing window focused/raised? **CONFIRMED** — Rapid double-click while session running: window count stayed at 2 (main + run-cli-terminal). No duplicate window. Evidence: window list at 2026-08-13T21:04:41Z, 2026-08-13T21:04:53Z.

- [ ] E-14: **Toolbar item click immediately after auto-close.** Click the toolbar item the instant the previous session's window closes. Does a fresh single window open cleanly, or does a stale/racing window appear? No "already running" false errors expected.

- [ ] E-15: **Toolbar item click while the error window is showing.** With the F-18 launch-failure error surface up, click the toolbar item again. No second window must open; the existing error window is reused/focused — record actual behavior (promotes to F-18/F-19 if a defect appears).

- [ ] E-16: **Toolbar overflow / narrow window.** Shrink the main window until the maomaolabs toolbar wraps or overflows. Is the Run CLI desktop item still reachable (wrap/scroll)? No partial rendering, no dropped item, no layout break of sibling items.

- [ ] E-17: **Keyboard-only activation.** Focus the Run CLI toolbar desktop item and press Enter/Space. Does the single terminal window launch (accessibility parity with mouse click)? Any focus-trap or missing-ARIA finding is a FAIL.

- [x] E-18: **Floating-button absence persistence.** After a launch → session close → relaunch cycle, and after a full app restart, the #2728 floating "RUN CLI" button never reappears and the toolbar desktop item remains the sole Run CLI affordance. Any re-appearance of the button or of a duplicate launch surface is a FAIL (promotes to F-12). **CONFIRMED** — After multiple launch/close cycles and app restart, no floating button appeared. Only toolbar item exists. Evidence: JS check at 2026-08-13T21:01:04Z, DOM snapshots throughout testing.
