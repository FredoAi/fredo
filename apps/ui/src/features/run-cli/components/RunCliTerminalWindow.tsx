import React, { useEffect, useRef } from 'react';
import { Box } from '@chakra-ui/react';
import '@xterm/xterm/css/xterm.css';
import { adapterBridge } from '../../../shared/utils/adapterBridge';

// ── Xterm renderer ────────────────────────────────────────────────────────────
const XtermRenderer: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let unlisten: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenSetup: (() => void) | null = null;
    let resizeObserver: ResizeObserver;
    let term: import('@xterm/xterm').Terminal;
    let fitAddon: import('@xterm/addon-fit').FitAddon;

    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (!containerRef.current) return;
        term = new Terminal({
          cursorBlink: true,
          fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
          fontSize: 14,
          lineHeight: 1.2,
          letterSpacing: 0,
          allowTransparency: false,
          scrollback: 5000,
          theme: {
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
          },
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);

        // Fit and immediately notify PTY of actual size
        const sendSize = () => {
          fitAddon.fit();
          adapterBridge.invoke('resize_pty', { rows: term.rows, cols: term.cols }).catch(() => {});
        };
        sendSize();

        term.onData((data: string) => {
          adapterBridge.invoke('write_pty_input', { data }).catch(() => {});
        });

        return import('@tauri-apps/api/event').then(({ listen }) => {
          // term.input(data, false) fires onData → write_pty_input (already wired below).
          // wasUserInput=false skips focus/selection side-effects.
          // The PTY echoes the command back via run-cli-output which renders it once.
          const listenSetup = listen<string>('setup-run-command', (ev) => {
            term.input(ev.payload, false);
          }).then(fn => { unlistenSetup = fn; });

          const listenOutput = listen<number[]>('run-cli-output', ev => {
            term.write(new Uint8Array(ev.payload));
          }).then(fn => {
            unlisten = fn;
            return adapterBridge.invoke<number[]>('get_pty_buffer')
              .then(buf => { if (buf?.length) term.write(new Uint8Array(buf)); });
          });

          const listenExit = listen('run-cli-exited', () =>
            term.writeln('\r\n\x1b[33m[Process exited]\x1b[0m'))
            .then(fn => { unlistenExit = fn; });

          return Promise.all([listenSetup, listenOutput, listenExit]);
        }).then(() => {
          resizeObserver = new ResizeObserver(() => sendSize());
          if (containerRef.current) resizeObserver.observe(containerRef.current);
        });
      });

    return () => {
      resizeObserver?.disconnect();
      unlisten?.();
      unlistenExit?.();
      unlistenSetup?.();
      term?.dispose();
    };
  }, []);

  return (
    <Box
      ref={containerRef}
      w="100%" h="100vh"
      background="#0d0d0d"
      overflow="hidden"
      css={{
        '.xterm': { height: '100%', padding: '8px' },
        '.xterm-viewport': { overflow: 'hidden !important' },
        '.xterm-screen': { height: '100% !important' },
      }}
    />
  );
};

// ── Root ──────────────────────────────────────────────────────────────────────
export const RunCliTerminalWindow: React.FC = () => <XtermRenderer />;
