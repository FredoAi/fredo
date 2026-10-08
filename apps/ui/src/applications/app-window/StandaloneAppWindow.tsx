/**
 * StandaloneAppWindow — the generic standalone app-window route root
 * (Spec #2955 ST-5).
 *
 * The Rust `open_app_window` host builds a native window at
 * `index.html?view=app&id=<appId>` with label `app-<appId>`; this component is
 * what that window loads (the `?view=app` branch in `Router.tsx`).
 *
 * It resolves the requested app from the SAME registry the main webview uses
 * (`allApplications` side-effect registration + `getApplications()`), calls the
 * feature's `onMount`/`onUnmount` lifecycle hooks for parity with the in-window
 * kernel, and renders `feature.render()`.
 *
 * Provider stack: the standalone window is loaded through the SAME entry
 * (`main.tsx`) as every other route, so the shared global providers (Chakra,
 * Theme, Stream, App, Companion, ReactFlow, Hotkeys) are already mounted around
 * `Router` — including for this route. Re-mounting them here would nest
 * side-effectful providers (a second `adapter.onMessage` row-delivery
 * subscription, a second hotkey engine + overlays, a second Chakra system), so
 * this route adds ONLY the one provider the main window's kernel supplies that
 * `main.tsx` does not: `WindowSystemProvider` (so `useWindowActions` never
 * throws outside the main window's kernel). There is deliberately NO
 * `WindowManager` here — a standalone window is not a nested in-window kernel.
 *
 * An absent id, an unregistered id, or a registered-but-not-`showable` feature
 * renders the `app-window-unknown` fallback (never a blank/crash).
 */

import React, { useEffect, useMemo } from 'react';
import { Flex, Heading, Icon, Text } from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';

import { WindowSystemProvider } from '../../shared/window-system/WindowSystemProvider';
import { dedupeByApplicationId, getApplications } from '../applicationRegistry';
import type { FredoApplicationClass } from '../../shared/classes/FredoApplicationClass';
// Side-effect import: registers every feature into the registry (the standalone
// window renders `Router`, not `Home`, so it must trigger registration itself).
import '../allApplications';

/** Binding root testid for a resolved standalone app window. */
export const STANDALONE_APP_WINDOW_ROOT_TESTID = 'app-window-root';
/** Binding fallback testid for an absent/unregistered/non-showable app id. */
export const STANDALONE_APP_WINDOW_UNKNOWN_TESTID = 'app-window-unknown';

/**
 * Read the app id from the `id` query param
 * (`index.html?view=app&id=<appId>`). Blank/whitespace-only → `null`.
 */
export function readStandaloneAppId(search: string = window.location.search): string | null {
  const raw = new URLSearchParams(search).get('id');
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve a registered, showable feature by id. Returns `null` when the id is
 * absent, unregistered, or the feature is not `showable` (R-4 fallback lever).
 */
export function resolveStandaloneFeature(
  appId: string | null,
  features: FredoApplicationClass[] = getApplications(),
): FredoApplicationClass | null {
  if (!appId) return null;
  const match = dedupeByApplicationId(features).find((feature) => feature.id === appId);
  return match && match.showable ? match : null;
}

export interface StandaloneAppWindowProps {
  /**
   * Test seam: override the URL-derived app id. Production (`Router`) omits it,
   * so the id always comes from `window.location.search`.
   */
  readonly appId?: string;
}

export const StandaloneAppWindow: React.FC<StandaloneAppWindowProps> = ({ appId }) => {
  const resolvedId = appId ?? readStandaloneAppId();
  const feature = useMemo<FredoApplicationClass | null>(
    () => resolveStandaloneFeature(resolvedId),
    [resolvedId],
  );

  // Lifecycle parity with the in-window kernel's openFeatureWindow (Home.tsx):
  // onMount on open, onUnmount on close. Async rejections are logged, never
  // thrown (a feature lifecycle hook must not break the route).
  useEffect(() => {
    if (!feature) return;
    const mounted = feature.onMount?.();
    if (mounted instanceof Promise) {
      mounted.catch((err) =>
        console.error('[StandaloneAppWindow] onMount threw:', feature.id, err),
      );
    }
    return () => {
      const unmounted = feature.onUnmount?.();
      if (unmounted instanceof Promise) {
        unmounted.catch((err) =>
          console.error('[StandaloneAppWindow] onUnmount threw:', feature.id, err),
        );
      }
    };
  }, [feature]);

  if (!feature) {
    return (
      <Flex
        data-testid={STANDALONE_APP_WINDOW_UNKNOWN_TESTID}
        direction="column"
        align="center"
        justify="center"
        gap="3"
        h="100vh"
        w="100%"
        bg="bg.canvas"
        color="fg.muted"
        textAlign="center"
        p="6"
      >
        <Icon as={LuTriangleAlert} boxSize="28px" color="status.warning" aria-hidden="true" />
        <Heading as="h1" size="md" color="fg.default">
          App unavailable
        </Heading>
        <Text fontSize="sm">
          This app isn&apos;t registered, or it can&apos;t be opened in its own window.
        </Text>
      </Flex>
    );
  }

  return (
    <Flex
      data-testid={STANDALONE_APP_WINDOW_ROOT_TESTID}
      direction="column"
      h="100vh"
      w="100%"
      minH={0}
      bg="bg.canvas"
      overflow="hidden"
    >
      <WindowSystemProvider>{feature.render()}</WindowSystemProvider>
    </Flex>
  );
};
