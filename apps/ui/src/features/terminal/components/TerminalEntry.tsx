import React, { useEffect, useSyncExternalStore } from 'react';
import { Box, Skeleton } from '@chakra-ui/react';
import {
  getTerminalPresentation,
  hydrateTerminalPresentation,
  isTerminalPresentationHydrated,
  subscribeTerminalPresentation,
  useTerminalPresentation,
} from '../presentation';
import {
  registerWindowCloseCallback,
  unregisterWindowCloseCallback,
} from '../../../shared/window-system/windowStore';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { TerminalWindow } from './TerminalWindow';
import { TerminalLauncher } from './TerminalLauncher';

/**
 * TerminalEntry — the mode-aware entry the Terminal feature renders inside the
 * main window (Spec #2947 ST-3).
 *
 * `TerminalFeature.render()` returns this instead of the launcher directly, so
 * EVERY in-window entry point — the launcher tile, the dock/toolbar desktop
 * item, `open-app`/`openSelf`, and the app-open CLI round trip — resolves the
 * persisted presentation mode through the ONE shipped `openFeatureWindow`
 * (no second spawner, no event-target change):
 *
 *  - `same-window` → the real workspace (`TerminalWindow`) renders in the
 *    main window's in-window kernel (id `terminal`) — no native OS window.
 *  - `new-window`  → the shipped `TerminalLauncher` fires
 *    `open_terminal_window` and closes the transient in-window entry, so the
 *    single native `terminal` window is used (today's behaviour, R-3.1).
 *
 * Hydration gate (G-224/G-225): the mode lives in a module-scoped store that
 * hydrates from `terminal_presentation_mode` asynchronously. Until it settles
 * the entry shows a bounded loading placeholder rather than flashing a wrong
 * host. The hold is cancelled by hydration settling (the store always flips
 * `hydrated` in `finally`) OR by unmount — `useSyncExternalStore` tears the
 * subscription down with the component, and `hydrateTerminalPresentation` is
 * idempotent + once-only at module scope. There is no `useEffect` + `setState`
 * and no array `.length` dependency (#523 rule) — the store notifies and
 * `useSyncExternalStore` re-reads the flag.
 *
 * The wrapper carries `data-testid="terminal-entry-root"` and fills its
 * definite-height content region so the same-window workspace keeps the shipped
 * sizing (no viewport unit — #2924).
 */
export const TerminalEntry: React.FC = () => {
  // Kick the (idempotent, once-only) hydration; the store notifies when it
  // settles. No setState here — the flag is read via useSyncExternalStore.
  useEffect(() => {
    void hydrateTerminalPresentation();
  }, []);

  const hydrated = useSyncExternalStore(
    subscribeTerminalPresentation,
    isTerminalPresentationHydrated,
    isTerminalPresentationHydrated,
  );
  const presentation = useTerminalPresentation();

  // FS-1 (R-5.2): a REAL user close of the in-window Terminal must drain and
  // tree-kill every live backend session through the shipped
  // `close_terminal_window` path (records retained → resumable).
  //
  // Registered on the module-scoped window store — NOT a React unmount cleanup
  // — so an HMR/StrictMode/re-render unmount never fires a drain; only a real
  // `closeWindow('terminal')` (chrome X / dock close) invokes the callback.
  //
  // ONLY in `same-window`: the new-window trampoline (`TerminalLauncher`) calls
  // `closeWindow('terminal')` on EVERY launch to dismiss its transient in-window
  // entry; registering there would drain the session the launcher just opened
  // (regresses R-6/F-13). The cleanup unregisters on the mode flip, and the
  // handler RE-READS the mode at close time because a mode-change teardown
  // (`TerminalSettings`) flips the store then closes the window in the same tick,
  // before React runs the cleanup — that teardown owns the drain and must not be
  // double-invoked.
  useEffect(() => {
    if (presentation !== 'same-window') return;
    registerWindowCloseCallback('terminal', () => {
      if (getTerminalPresentation() !== 'same-window') return;
      void adapterBridge.invoke('close_terminal_window').catch(() => {
        // Best-effort: the window is already gone; a failed drain must not surface.
      });
    });
    return () => {
      unregisterWindowCloseCallback('terminal');
    };
  }, [presentation]);

  return (
    <Box data-testid="terminal-entry-root" h="100%" w="100%" minH={0}>
      {!hydrated ? (
        <Skeleton data-testid="terminal-entry-loading" h="100%" w="100%" borderRadius="md" />
      ) : presentation === 'same-window' ? (
        <TerminalWindow />
      ) : (
        <TerminalLauncher />
      )}
    </Box>
  );
};
