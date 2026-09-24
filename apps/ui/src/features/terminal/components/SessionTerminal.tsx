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
        resizeDisposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (!activeRef.current) return;
          adapterBridge.invoke('resize_pty', { sessionId, rows, cols }).catch(() => {});
        });
        dataDisposable = term.onData((data: string) => {
          adapterBridge.invoke('write_pty_input', { sessionId, data }).catch(() => {});
        });

        // Fit the canvas to the observed box and publish the APPLIED grid as a
        // receipt (`onFit`, C-2) so the pane can stamp `data-cols`/`data-rows`.
        // Guarded on a real box: a not-yet-laid-out mount reports 0×0, and a
        // 0×0 fit would push a bogus size / publish a bogus receipt.
        const fitAndPublish = () => {
          const el = containerRef.current;
          if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return;
          try {
            fitAddon?.fit();
          } catch {
            /* not laid out yet — no fit applied, so no receipt */
            return;
          }
          if (term) onFitRef.current?.(term.cols, term.rows);
        };

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

        // Fit after layout settles (hidden-canvas fit yields 0×0).
        requestAnimationFrame(() => {
          if (disposed) return;
          fitAndPublish();
          if (activeRef.current) termRef.current?.focus();
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
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current;
      const term = termRef.current;
      const fitAddon = fitRef.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0 && fitAddon) {
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
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <Box
      ref={containerRef}
      data-testid={`terminal-canvas-host-${sessionId}`}
      w="100%"
      h="100%"
      background={GHOSTTY_THEME.background}
      overflow="hidden"
    />
  );
};
