/**
 * Window-system navigation provider + floating dock (Spec #3121, ST-2 — P7 fleet migration).
 *
 * Mounted ONCE by `WindowManager` (never per window). Creates the ONE navigation host for
 * the `window-system` surface, registers it for the launcher's synchronous registry read,
 * publishes focused-window changes through `host.refreshContext()`, and renders the
 * floating command-bar dock (UI/UX §4).
 *
 * The dock is pointer-inert except for its own controls: the wrapper is
 * `pointerEvents:"none"` and only the listed interactive descendants re-enable pointer
 * events, so a click on the dock's background or breadcrumb falls through to the window
 * underneath. The dock adds ZERO keydown handling — the three kept platform globals already
 * delegate into this host through `engine.ts` `runIntent({channel:'keyboard'})` (D-3(a)).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { Box } from '@chakra-ui/react';

import type { ContextSnapshot, SelectionSnapshot, Surface } from '../navigation';
import {
  ActivityTrail,
  CommandRail,
  NavigationMap,
  buildActivityTrailModel,
  buildCommandRailModel,
  buildNavigationMapModel,
  createNavigationHost,
  registerNavigationHost,
  useNavigationHostSnapshot,
  type NavigationHost,
} from '../navigation/ui';
import { requestCompanionComposerOpen } from '../companion/composerBridge';
import {
  WINDOW_OBJECT_TYPE,
  WINDOW_SYSTEM_APP_ID,
  getWindowSystemContext,
  windowSystemSurface,
} from './windowSystemSurface';
import { getWindowSnapshot, subscribeWindows } from './windowStore';
import type { WindowEntry } from './windowTypes';

/* ───────────────────────────── context ───────────────────────────── */

export interface WindowSystemNavigationValue {
  readonly host: NavigationHost;
  readonly surface: Surface;
}

const WindowSystemNavigationContext = createContext<WindowSystemNavigationValue | null>(null);

export interface WindowSystemNavigationProviderProps {
  readonly children?: React.ReactNode;
}

/** The focused window id from a store snapshot, or `null`. */
function focusedIdOf(windows: readonly WindowEntry[]): string | null {
  return windows.find((win) => win.focused)?.id ?? null;
}

/** The live selection projection (§D.4 window row). */
function selectionFor(windows: readonly WindowEntry[]): SelectionSnapshot {
  const focusedId = focusedIdOf(windows);
  return focusedId === null
    ? { count: 0, kinds: [], label: null, ids: [] }
    : { count: 1, kinds: [WINDOW_OBJECT_TYPE], label: WINDOW_OBJECT_TYPE, ids: [focusedId] };
}

/**
 * Create + provide the ONE window-system navigation host.
 *
 * The host is built in `useMemo` (no timers, no storage) and registers its surface on
 * mount; the disposer unregisters it. Context freshness is published from the window
 * store — a pure focus change flips the selection without a verb dispatch (R-12).
 */
export function WindowSystemNavigationProvider({
  children,
}: WindowSystemNavigationProviderProps): React.ReactElement {
  const value = useMemo<WindowSystemNavigationValue>(() => {
    const host = createNavigationHost({
      surface: windowSystemSurface,
      getContext: getWindowSystemContext,
      announcementChannel: 'legacy',
    });
    return { host, surface: windowSystemSurface };
  }, []);

  useEffect(
    () =>
      registerNavigationHost({
        appId: WINDOW_SYSTEM_APP_ID,
        surface: windowSystemSurface,
        host: value.host,
      }),
    [value.host],
  );

  // Publish focused-window changes: a store-only focus move never reaches a host
  // mutation, so without this the context envelope keeps the stale selection. Only a
  // real focus-id change touches the host (no render loop — #523).
  useEffect(() => {
    const host = value.host;
    let focusedId = focusedIdOf(getWindowSnapshot());
    return subscribeWindows(() => {
      const next = focusedIdOf(getWindowSnapshot());
      if (next === focusedId) return;
      focusedId = next;
      host.refreshContext();
    });
  }, [value.host]);

  return (
    <WindowSystemNavigationContext.Provider value={value}>
      {children}
    </WindowSystemNavigationContext.Provider>
  );
}

/** The provider's host + surface; throws when used outside the provider. */
export function useWindowSystemNavigation(): WindowSystemNavigationValue {
  const value = useContext(WindowSystemNavigationContext);
  if (value === null) {
    throw new Error('useWindowSystemNavigation must be used inside WindowSystemNavigationProvider');
  }
  return value;
}

/**
 * The floating command-bar dock (UI/UX §4). Rendered as the last child of the window
 * manager so it stacks above every frame (`zIndex="overlay"`) while remaining under the
 * navigation map's modal layer.
 */
export function WindowSystemNavigationDock(): React.ReactElement {
  const { host, surface } = useWindowSystemNavigation();
  const snapshot = useNavigationHostSnapshot(host);
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);

  // A value-identical merge of the host's place path with the live store selection — never
  // a second freshness source (the P5 `useFreshWireframeContext` pattern).
  const context = useMemo<ContextSnapshot>(
    () => ({ ...snapshot.context, selection: selectionFor(windows) }),
    [snapshot.context, windows],
  );

  const rail = useMemo(() => buildCommandRailModel(surface, context), [surface, context]);
  const map = useMemo(
    () =>
      buildNavigationMapModel(surface, context, {
        filteredTo: snapshot.mapFilterPlaceId,
      }),
    [surface, context, snapshot.mapFilterPlaceId],
  );
  const trail = useMemo(
    () => buildActivityTrailModel(surface, snapshot.entries),
    [surface, snapshot.entries],
  );

  const runPointerVerb = useCallback(
    (verbId: string) => {
      void host.runVerb(verbId, 'pointer', {});
    },
    [host],
  );

  const openCompanionComposer = useCallback(() => {
    requestCompanionComposerOpen({
      source: 'command-bar-ask',
      appId: WINDOW_SYSTEM_APP_ID,
      focus: true,
    });
  }, []);

  return (
    <Box
      position="absolute"
      left="50%"
      bottom="12px"
      transform="translateX(-50%)"
      width="min(720px, calc(100% - 32px))"
      zIndex="overlay"
      pointerEvents="none"
      display="flex"
      flexDirection="column"
      gap="1"
      alignItems="stretch"
    >
      {trail.entries.length > 0 ? (
        <Box
          pointerEvents="none"
          maxH="96px"
          overflowY="auto"
          css={{
            '& [data-testid="navigation-trail-undo"]': { pointerEvents: 'auto' },
          }}
        >
          <ActivityTrail
            model={trail}
            compact
            onUndo={(seq) => {
              void host.undoEntry(seq);
            }}
          />
        </Box>
      ) : null}
      <Box
        pointerEvents="none"
        css={{
          '& [data-nav-verb-id]': { pointerEvents: 'auto' },
          '& [data-testid="navigation-rail-place-row"]': { pointerEvents: 'auto' },
          '& [data-testid="navigation-bar-more"]': { pointerEvents: 'auto' },
          '& [data-testid="navigation-bar-map"]': { pointerEvents: 'auto' },
          '& [data-testid="navigation-bar-ask"]': { pointerEvents: 'auto' },
        }}
      >
        <CommandRail
          model={rail}
          onRunVerb={runPointerVerb}
          onOpenMap={(filterPlaceId) => host.openMap(filterPlaceId ?? null)}
          onAsk={openCompanionComposer}
        />
      </Box>
      <NavigationMap
        model={map}
        open={snapshot.mapOpen}
        onClose={() => host.closeMap()}
        onRunVerb={runPointerVerb}
      />
    </Box>
  );
}
