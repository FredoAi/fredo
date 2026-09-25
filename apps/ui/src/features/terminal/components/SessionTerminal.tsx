import React, { useEffect, useRef } from 'react';
import { Box } from '@chakra-ui/react';
import { init, Terminal, FitAddon } from 'ghostty-web';
import { adapterBridge } from '../../../shared/utils/adapterBridge';

/**
 * Ghostty palette (data palette literal — ghostty-web owns the canvas colours;
 * all window chrome reads Fredo theme tokens). Unchanged from the shipped
 * renderer (Spec 2934 ST-3 N-4 allowlist).
 */
const GHOSTTY_THEME = {
  background:    '#0d0d0d',
  foreground:    '#e0e0e0',
  cursor:        '#e0e0e0',
  cursorAccent:  '#0d0d0d',
  black:         '#0d0d0d',
  red:           '#f44747',
  green:         '#4ec9b0',
  yellow:        '#dcdcaa',
  blue:          '#569cd6',
  magenta:       '#c586c0',
  cyan:          '#9cdcfe',
  white:         '#d4d4d4',
  brightBlack:   '#808080',
  brightRed:     '#f44747',
  brightGreen:   '#4ec9b0',
  brightYellow:  '#dcdcaa',
  brightBlue:    '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan:    '#9cdcfe',
  brightWhite:   '#ffffff',
};

/**
 * Spec #2942 ST-5 — the pane/grid fit fix (the ticket's named residual:
 * "OpenCode TUI doesn't fill the pane").
 *
 * Root cause chain (SA §8): the PTY was born at a hardcoded 80×24
 * (`commands.rs`); `resize_pty` fires only on a CHANGED grid (ghostty's FitAddon
 * is a no-op for an equal grid), and the mount fit could latch a transiently
 * tiny box (measured 71×4 in #2934 round 3) whose only correction was a later
 * active-only, rAF-coalesced ResizeObserver frame.
 *
 * Three countermeasures live here:
 *   (ii) ONE unconditional settling `resize_pty` after the mount/activation fit
 *        settles (double rAF) — even when the grid is unchanged. This
 *        deterministically reproduces the tester-proven "forced resize".
 *   (iv) a FLOOR on the box guard: a transiently smaller box is never fitted,
 *        published, or pushed (the sink for the 71×4 latch).
 *   (iii) the last-good grid for the next spawn is kept by the window
 *        (`TerminalPane.onGridChange` → `TerminalWindow.lastGridRef`).
 */

/** Below this the box is mid-layout (min window pane ≈ 360×335 px). */
const MIN_FIT_BOX_PX = 120;
/** A grid below this is a transiently-small box, never a real pane. */
const MIN_FIT_COLS = 10;
const MIN_FIT_ROWS = 6;

interface SessionTerminalProps {
  sessionId: string;
  /** The session is the selected one — visible + owns the pane geometry. */
  active: boolean;
  /** Fired on the first PTY byte for this session (live event OR replay). */
  onFirstOutput?: (sessionId: string) => void;
  /**
   * Last applied fit dimensions for this session (stamped after every applied
   * fit). Optional: a caller that does not pass it still compiles and the
   * terminal behaves identically. `TerminalPane` passes it only for the ACTIVE
   * session so the pane can publish `data-cols`/`data-rows` (C-2).
   */
  onFit?: (cols: number, rows: number) => void;
}

/**
 * One mounted Ghostty terminal per session (Spec 2934 ST-3 rendering
 * contract).
 *
 * Mounted ONCE per session and toggled with `visibility` (never `display:none`)
 * so a switch loses no scrollback and never re-inits the terminal. The pane is
 * shared, so only the ACTIVE session may drive `resize_pty` — a deactivated
 * terminal defers its re-fit to the activation effect, which re-fits BEFORE
 * accepting resize events (a hidden-canvas fit yields 0×0).
 *
 * All PTY I/O is session-scoped: `get_pty_buffer`/`write_pty_input`/`resize_pty`
 * carry `sessionId`, and the `terminal-output`/`terminal-exited` listeners filter
 * by the payload's `sessionId`.
 */
export const SessionTerminal: React.FC<SessionTerminalProps> = ({
  sessionId,
  active,
  onFirstOutput,
  onFit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  // Callbacks are read through refs so the init effect depends ONLY on
  // `sessionId` — an inline parent callback must never re-initialise the
  // terminal (that would remount and drop scrollback).
  const onFirstOutputRef = useRef(onFirstOutput);
  const onFitRef = useRef(onFit);
  const firstOutputFiredRef = useRef(false);
  /**
   * The last grid this surface pushed UNCONDITIONALLY (Spec #2942 ST-5 ii).
   * Reset on every activation so exactly ONE settling `resize_pty` follows the
   * mount/activation fit even when ghostty reports no grid change.
   */
  const settledGridRef = useRef<{ cols: number; rows: number } | null>(null);
  /** The init effect's settling-push trigger, callable from the activation effect. */
  const settleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    onFirstOutputRef.current = onFirstOutput;
    onFitRef.current = onFit;
  });

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let resizeDisposable: { dispose(): void } | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;
    let settleFrame = 0;

    const fireFirstOutput = () => {
      if (firstOutputFiredRef.current) return;
      firstOutputFiredRef.current = true;
      onFirstOutputRef.current?.(sessionId);
    };

    init()
      .then(() => {
        const container = containerRef.current;
        if (disposed || !container) return;

        term = new Terminal({
          cursorBlink: true,
          fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
          fontSize: 14,
          allowTransparency: false,
          scrollback: 5000,
          theme: GHOSTTY_THEME,
        });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        termRef.current = term;
        fitRef.current = fitAddon;

        // Only the active session owns the pane geometry; a deactivated terminal
        // re-fits on activation instead of pushing a stale/zero size to its PTY.
        // A grid below the floor is a transiently-small box (Spec #2942 ST-5 iv)
        // and is never pushed; a real push is recorded so the settling push below
        // stays idempotent for the common (changed-grid) mount.
        resizeDisposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (!activeRef.current) return;
          if (cols < MIN_FIT_COLS || rows < MIN_FIT_ROWS) return;
          settledGridRef.current = { cols, rows };
          adapterBridge.invoke('resize_pty', { sessionId, rows, cols }).catch(() => {});
        });
        dataDisposable = term.onData((data: string) => {
          adapterBridge.invoke('write_pty_input', { sessionId, data }).catch(() => {});
        });

        // Fit the canvas to the observed box and publish the APPLIED grid as a
        // receipt (`onFit`, C-2) so the pane can stamp `data-cols`/`data-rows`.
        // Guarded on a REAL box (Spec #2942 ST-5 iv): a not-yet-laid-out mount
        // reports 0×0 AND a partially laid-out pass can report a transiently tiny
        // box (measured 71×4 in #2934 round 3) — fitting either would push a
        // bogus size / publish a bogus receipt.
        const fitAndPublish = () => {
          const el = containerRef.current;
          if (!el || el.clientWidth < MIN_FIT_BOX_PX || el.clientHeight < MIN_FIT_BOX_PX) return;
          try {
            fitAddon?.fit();
          } catch {
            /* not laid out yet — no fit applied, so no receipt */
            return;
          }
          if (term) onFitRef.current?.(term.cols, term.rows);
        };

        // (ii) Push ONE settling `resize_pty` after the mount/activation fit has
        // settled — even when the grid did NOT change. ghostty's FitAddon is a
        // no-op for an equal grid (pinned at SessionTerminal.resize.test.tsx:53),
        // so a PTY born at a stale size had no correction on the cold-mount path.
        // This deterministically reproduces the tester-proven forced resize; when
        // the fit DID change the grid, `term.onResize` already pushed it and the
        // dedupe below keeps this idempotent.
        const pushSettlingResize = () => {
          const el = containerRef.current;
          const term = termRef.current;
          if (!el || el.clientWidth < MIN_FIT_BOX_PX || el.clientHeight < MIN_FIT_BOX_PX) return;
          if (!term) return;
          const { cols, rows } = term;
          if (cols < MIN_FIT_COLS || rows < MIN_FIT_ROWS) return;
          const last = settledGridRef.current;
          if (last && last.cols === cols && last.rows === rows) return;
          settledGridRef.current = { cols, rows };
          adapterBridge.invoke('resize_pty', { sessionId, rows, cols }).catch(() => {});
        };

        // Double rAF: one frame for the fit's layout write, one for it to settle.
        const settleThenPush = () => {
          cancelAnimationFrame(settleFrame);
          settleFrame = requestAnimationFrame(() => {
            settleFrame = requestAnimationFrame(() => {
              if (disposed || !activeRef.current) return;
              pushSettlingResize();
            });
          });
        };
        settleRef.current = settleThenPush;

        // A window/pane resize must re-fit the ACTIVE terminal so its
        // `term.onResize` pushes a fresh `resize_pty` (the activation effect
        // only covers a deselect→select transition, not a live window resize).
        // Coalesce through a frame (one fit per frame, never per-event IPC
        // churn) and gate on two conditions:
        //   - ACTIVE only: an inactive terminal's `onResize` is suppressed, so a
        //     silent fit would leave its PTY at a stale size and make the later
        //     activation fit a no-op.
        //   - real box only: a not-yet-laid-out mount reports 0×0, and a
        //     0×0 fit would push a bogus size.
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (disposed) return;
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
              if (disposed || !activeRef.current) return;
              fitAndPublish();
            });
          });
          resizeObserver.observe(container);
        }

        // Fit after layout settles (hidden-canvas fit yields 0×0), then schedule
        // the ONE unconditional settling push (Spec #2942 ST-5 ii).
        requestAnimationFrame(() => {
          if (disposed) return;
          fitAndPublish();
          if (activeRef.current) termRef.current?.focus();
          settleThenPush();
        });

        // Replay this session's buffered output (independent of live listeners —
        // with window-first launch the reader emits before `listen()` registers).
        const replay = adapterBridge
          .invoke<number[]>('get_pty_buffer', { sessionId })
          .then((buf) => {
            if (disposed || !buf?.length) return;
            fireFirstOutput();
            term?.write(new Uint8Array(buf));
          })
          .catch((err) => console.error('[Terminal] pty buffer replay failed:', err));

        // Live per-session events, filtered by the payload's sessionId.
        const listeners = Promise.allSettled([
          adapterBridge
            .listen<{ sessionId: string; data: number[] }>('terminal-output', (ev) => {
              if (ev?.sessionId !== sessionId) return;
              fireFirstOutput();
              term?.write(new Uint8Array(ev.data));
            })
            .then((fn) => {
              unlistenOutput = fn;
            }),
          adapterBridge
            .listen<{ sessionId: string }>('terminal-exited', (ev) => {
              if (ev?.sessionId !== sessionId) return;
              term?.writeln('\r\n\x1b[33m[Process exited]\x1b[0m');
            })
            .then((fn) => {
              unlistenExit = fn;
            }),
        ]);
        void Promise.allSettled([replay, listeners]);
      })
      .catch((err) => console.error('[Terminal] ghostty init failed:', err));

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(settleFrame);
      settleRef.current = null;
      resizeObserver?.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      resizeDisposable?.dispose();
      dataDisposable?.dispose();
      fitAddon?.dispose();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Activation: re-fit BEFORE accepting resize events, then move focus into the
  // newly visible terminal so keystrokes land in the right PTY immediately. The
  // applied dims are published as a fit receipt (C-2) — never from a 0×0 box.
  // Spec #2942 ST-5 (ii): the settling push is re-armed on every activation (a
  // deselect→select with an unchanged grid still seeds the PTY once).
  useEffect(() => {
    if (!active) return;
    settledGridRef.current = null;
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current;
      const term = termRef.current;
      const fitAddon = fitRef.current;
      if (el && el.clientWidth >= MIN_FIT_BOX_PX && el.clientHeight >= MIN_FIT_BOX_PX && fitAddon) {
        let fitted = false;
        try {
          fitAddon.fit();
          fitted = true;
        } catch {
          /* not laid out yet — no fit applied, so no receipt */
        }
        if (fitted && term) onFitRef.current?.(term.cols, term.rows);
      }
      term?.focus();
      settleRef.current?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <Box
      ref={containerRef}
      data-testid={`terminal-canvas-host-${sessionId}`}
      // Spec #2946 ST-12 — the terminal passthrough detector's anchor (R-5.7).
      // The hotkey engine classifies focus inside this root as `terminal` and
      // suspends dispatch so every keystroke reaches the PTY.
      data-fredo-terminal-root="true"
      w="100%"
      h="100%"
      background={GHOSTTY_THEME.background}
      overflow="hidden"
    />
  );
};
