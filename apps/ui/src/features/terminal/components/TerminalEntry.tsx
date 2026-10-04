import React, { useEffect } from 'react';
import { Box } from '@chakra-ui/react';
import {
  registerWindowCloseCallback,
  unregisterWindowCloseCallback,
} from '../../../shared/window-system/windowStore';
import {
  getAppPresentation,
  hydrateAppPresentation,
} from '../../../shared/window-system/appPresentationStore';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { TerminalWindow } from './TerminalWindow';

/** The Terminal feature id used as its key in the per-app presentation map. */
const TERMINAL_APP_ID = 'terminal';

/**
 * TerminalEntry — the in-window Terminal host (Spec #2947 ST-3, reworked by
 * #2955 ST-4).
 *
 * `TerminalFeature.render()` returns this. It now ALWAYS renders the real
 * workspace (`TerminalWindow`): the per-app presentation choice is owned by the
 * ONE presentation-aware opener (`Home.openApp`), which never routes a
 * `new-window` Terminal through the in-window kernel at all. The old
 * render-time trampoline (`new-window` → `TerminalLauncher` firing
 * `open_terminal_window` then closing the transient entry) is RETIRED — the
 * opener owns that branch, so this component no longer reads the mode to pick a
 * host and no longer needs a hydration gate.
 *
 * The wrapper keeps `data-testid="terminal-entry-root"` and fills its
 * definite-height content region so the workspace keeps the shipped sizing (no
 * viewport unit — #2924).
 */
export const TerminalEntry: React.FC = () => {
  // Kick the (idempotent, once-only) store hydration so the close-time guard
  // below reads an accurate mode. No setState — the store notifies its own
  // subscribers; there is no render-time mode branch any more.
  useEffect(() => {
    void hydrateAppPresentation();
  }, []);

  // FS-1 (R-5.2): a REAL user close of the in-window Terminal must drain and
  // tree-kill every live backend session through the shipped
  // `close_terminal_window` path (records retained → resumable).
  //
  // Registered on the module-scoped window store — NOT a React unmount cleanup
  // — so an HMR/StrictMode/re-render unmount never fires a drain; only a real
  // `closeWindow('terminal')` (chrome X / dock close) invokes the callback.
  //
  // The handler RE-READS the mode at close time because a mode-change teardown
  // (Settings → Apps) flips the store then closes the window in the same tick,
  // before React runs any cleanup — that teardown owns the drain and must not be
  // double-invoked. `getAppPresentation` is the platform default (`same-window`)
  // until hydration settles, so an in-window close always drains.
  useEffect(() => {
    registerWindowCloseCallback(TERMINAL_APP_ID, () => {
      if (getAppPresentation(TERMINAL_APP_ID) !== 'same-window') return;
      void adapterBridge.invoke('close_terminal_window').catch(() => {
        // Best-effort: the window is already gone; a failed drain must not surface.
      });
    });
    return () => {
      unregisterWindowCloseCallback(TERMINAL_APP_ID);
    };
  }, []);

  return (
    <Box data-testid="terminal-entry-root" h="100%" w="100%" minH={0}>
      <TerminalWindow />
    </Box>
  );
};
