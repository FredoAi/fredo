import React, { useEffect, useSyncExternalStore } from 'react';
import { Box, Skeleton } from '@chakra-ui/react';
import {
  hydrateTerminalPresentation,
  isTerminalPresentationHydrated,
  subscribeTerminalPresentation,
  useTerminalPresentation,
} from '../presentation';
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
