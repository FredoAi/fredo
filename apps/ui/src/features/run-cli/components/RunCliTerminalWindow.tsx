import React, { useCallback, useEffect, useRef } from 'react';
import { Box } from '@chakra-ui/react';
import { init, Terminal, FitAddon } from 'ghostty-web';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { RunCliLaunchStatus } from './RunCliLaunchStatus';

// ── Ghostty terminal palette (existing dark palette verbatim — ghostty-web
//    owns the canvas colors; the window chrome uses Fredo theme tokens) ───────
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

interface GhosttyTerminalProps {
  /** Fired on the first PTY output byte (live event OR buffer replay). */
  onFirstOutput?: () => void;
}

// ── Ghostty renderer (drop-in replacement for the xterm renderer) ────────────
// Keeps every existing IPC wiring contract: `run-cli-output` → term.write,
// term.onData → write_pty_input, term.onResize → resize_pty, get_pty_buffer
// replay on mount. Drops the xterm CSS import, the xterm-specific container
// CSS, and the dead `setup-run-command` listener (no backend emitter exists).
export const GhosttyTerminal: React.FC<GhosttyTerminalProps> = ({ onFirstOutput }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const firstOutputFiredRef = useRef(false);

  const fireFirstOutput = useCallback(() => {
    if (firstOutputFiredRef.current) return;
    firstOutputFiredRef.current = true;
    onFirstOutput?.();
  }, [onFirstOutput]);

  useEffect(() => {
    if (!containerRef.current) return;
    let unlisten: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let resizeDisposable: { dispose(): void } | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let disposed = false;

    // init() is a module-level singleton; the wasm is base64-inlined in the
    // bundle (no separate asset fetch). No top-level await (es2020 target).
    init()
      .then(() => {
        if (disposed || !containerRef.current) return;

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
        term.open(containerRef.current);

        // term.onResize fires on every resize (incl. FitAddon.fit) → notify PTY.
        resizeDisposable = term.onResize(({ cols, rows }) => {
          adapterBridge.invoke('resize_pty', { rows, cols }).catch(() => {});
        });

        dataDisposable = term.onData((data: string) => {
          adapterBridge.invoke('write_pty_input', { data }).catch(() => {});
        });

        // Fit to the container now (fires onResize → resize_pty with real
        // dims), then observe container resizes (ResizeObserver → fit).
        fitAddon.fit();
        fitAddon.observeResize();

        term.focus();

        // Replay buffered PTY output as soon as the terminal is open, fired
        // INDEPENDENTLY of the listener chain (FIX-1 round 2). With window-first
        // launch the reader emits the initial burst before this webview's
        // `listen()` registers — those events are not queued by Tauri, so the
        // `get_pty_buffer` replay is the ONLY path that renders them and fades
        // the loading overlay. Gating the replay on `listen()` resolving means
        // a listener hiccup blanks the terminal and the overlay never fades.
        const replay = adapterBridge.invoke<number[]>('get_pty_buffer')
          .then((buf) => {
            if (buf?.length) {
              fireFirstOutput();
              term?.write(new Uint8Array(buf));
            }
          })
          .catch((err) => console.error('[RunCli] pty buffer replay failed:', err));

        // Register live event listeners in PARALLEL with the replay. A failure
        // in one must not block the other (allSettled) — replay + live events
        // are independent delivery paths for the same PTY bytes.
        const listeners = import('@tauri-apps/api/event').then(({ listen }) =>
          Promise.allSettled([
            listen<number[]>('run-cli-output', (ev) => {
              fireFirstOutput();
              term?.write(new Uint8Array(ev.payload));
            }).then((fn) => { unlisten = fn; }),
            listen('run-cli-exited', () =>
              term?.writeln('\r\n\x1b[33m[Process exited]\x1b[0m'))
              .then((fn) => { unlistenExit = fn; }),
          ]));

        return Promise.allSettled([replay, listeners]);
      })
      .catch((err) => {
        console.error('[RunCli] ghostty init failed:', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenExit?.();
      resizeDisposable?.dispose();
      dataDisposable?.dispose();
      fitAddon?.dispose();
      term?.dispose();
    };
  }, [fireFirstOutput]);

  return (
    <Box
      ref={containerRef}
      w="100%"
      h="100%"
      background="#0d0d0d"
      overflow="hidden"
    />
  );
};

// ── Root ──────────────────────────────────────────────────────────────────────
export const RunCliTerminalWindow: React.FC = () => (
  <RunCliLaunchStatus renderTerminal={({ onFirstOutput }) => (
    <GhosttyTerminal onFirstOutput={onFirstOutput} />
  )} />
);
