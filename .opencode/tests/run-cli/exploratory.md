# Run CLI — Exploratory Test Suite

Feature domain: `run-cli`. Unscripted edge/failure probes for Spec #2728 (single-window launch + ghostty-web terminal).
Run beyond the scripted functional cases. A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

Conventions: ID prefix `E-`. Record expected vs actual; mark `FAIL` with repro if behavior is wrong.

## Probe prompts

- [ ] E-1: **Rapid double-click on "Run CLI".** Two clicks within ~200 ms. Does exactly one window open (single-instance guard), or do two windows appear? Expected per AC1: exactly one; a second window is a FAIL (promotes to F-1).

- [ ] E-2: **Relaunch immediately after auto-close.** Click "Run CLI" the instant the previous session's window closes (F-7). Does the new launch open a fresh single window cleanly, or does a stale/racing window appear? No "already running" false errors expected.

- [ ] E-3: **Window resize mid-session.** Resize the terminal window while a long output is streaming. Does the ghostty surface reflow and the PTY receive a resize (`resize_pty`)? Any scrollback loss or garbled rendering at extreme sizes (min 400×300)?

- [ ] E-4: **Long/continuous output.** A command producing thousands of lines (e.g. a long diff or `ls -R` of a big tree). Does ghostty stay responsive, does output stay complete, does the console stay clean (no `Maximum update depth exceeded`)? Note scrollback behavior.

- [ ] E-5: **Unicode/wide-character output.** Output containing emoji, CJK, and combining characters. Does ghostty render them correctly (no mojibake, no broken wide-char cells)? Compare visually against the pre-spec xterm rendering if receipts exist.

- [ ] E-6: **ANSI color fidelity.** A program emitting 256-color/truecolor ANSI (e.g. opencode TUI itself, `cargo` output). Are colors/backgrounds rendered correctly (TERM=xterm-256color / COLORTERM=truecolor are set in `commands.rs`)? Any color mismatch vs xterm is a cosmetic finding — report.

- [ ] E-7: **Ctrl-C / interrupt.** Send Ctrl-C to an in-progress tool call. Does the interrupt reach the process and the TUI recover to the prompt? Does the window stay healthy?

- [ ] E-8: **Work dir with spaces/unicode, and nonexistent dir.** (a) A fixture dir with spaces/unicode — `pwd` must return it exactly. (b) A deleted/nonexistent configured dir — clear launch error (AC5 surface), no hang, main window unaffected. Promotes to F-6/F-8 if behavior confirms.

- [ ] E-9: **External process kill.** Kill the opencode process externally (taskkill/`kill`). Does the window auto-close (AC4) or hang with a stale terminal? Any zombie window or orphaned PTY?

- [ ] E-10: **Long session memory stability.** Keep a session running for an extended period with steady output. No unbounded memory growth in the webview; console clean.

- [ ] E-11: **Main-window interaction during heavy streaming.** While a very long output streams, open/close other features in the main window. Main window must stay responsive (NFR) — any freeze/jank is a FAIL (promotes to F-10).

- [ ] E-12: **Theme surface.** The terminal is a native surface; confirm the terminal window's own chrome/background is legible in both light and dark themes (no hardcoded colors breaking readability; ghostty's own background is acceptable as a terminal surface).
