/**
 * Dev Mode navigation provider (Spec #3121, ST-5 — P7 fleet migration).
 *
 * Creates the ONE NavigationEngine host for the Dev Mode application, registers it for the
 * synchronous registry reads (`describeContext`), publishes the ACTIVE VIEW as the injected
 * context, and owns the ONE element-scoped key adapter. The shared bottom footer
 * (`CommandRail` / `ActivityTrail` / `NavigationMap`) is rendered by `DevMode` as the app
 * root's LAST flex child (UI/UX §3) — this provider adds no DOM of its own, so the shipped
 * Dev Mode root stays the semantic root.
 *
 * Follows the P5 `WireframeNavigationProvider` pattern exactly:
 *   - the host is built in `useMemo` (no timers, no I/O);
 *   - `registerNavigationHost` runs in a mount effect and returns its disposer;
 *   - a view change publishes through `host.refreshContext()` (only on a REAL change);
 *   - ONE element-scoped `onKeyDown` on the app root — never a `document` keydown listener,
 *     never a poll.
 *
 * The view IS the place (Architect §B.3 / UI/UX D-UI-1's mode-place exception): the injected
 * `placePath` derives from the active view, the view-switch verbs set a synchronous ref before
 * dispatching so the host's `navigationPath` adopts the new view, and the pointer view toggles
 * run through the SAME declared verbs (one dispatch funnel).
 *
 * The footer is exposed as a CHILD-RENDER value (`onKeyDown` + `runView`) rather than a
 * wrapper element because Dev Mode's root is already the column the footer must be appended
 * to: adding a second root would be a semantic-root change the UI/UX section forbids.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Flex } from '@chakra-ui/react';

import type { ContextSnapshot, SelectionSnapshot, Surface } from '../../../shared/navigation';
import {
  ActivityTrail,
  CommandRail,
  NavigationMap,
  buildActivityTrailModel,
  buildCommandRailModel,
  buildNavigationMapModel,
  createNavigationHost,
  registerNavigationHost,
  requestLauncherConfirmation,
  useNavigationHostSnapshot,
  type NavigationHost,
} from '../../../shared/navigation/ui';
import { requestCompanionComposerOpen } from '../../../shared/companion/composerBridge';
import { isTextControl } from '../../../shared/hotkeys/focusContext';
import {
  DEV_MODE_APPLICATION_DATA_PLACE_ID,
  DEV_MODE_EVENTS_PLACE_ID,
  DEV_MODE_SURFACE_APP_ID,
  DEV_MODE_VIEW_APPLICATION_DATA,
  DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
  DEV_MODE_VIEW_ROWS,
  DEV_MODE_VIEW_ROWS_VERB_ID,
  devModeSurface,
  getDevModeActionHandlers,
  setDevModeActionHandlers,
  type DevModeActionHandlers,
  type DevModeViewId,
} from '../devModeSurface';

/* ───────────────────────────── context ───────────────────────────── */

export interface DevModeNavigationValue {
  readonly host: NavigationHost;
  readonly surface: Surface;
}

const DevModeNavigationContext = createContext<DevModeNavigationValue | null>(null);

/** The value handed to the app root: the ONE key adapter + the pointer view runner. */
export interface DevModeNavigationSurfaceBindings {
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly runView: (view: DevModeViewId) => void;
}

/* ───────────────────────────── read model ───────────────────────────── */

/** §D.4 — the active view is the one selected `panel`. */
function selectionFor(view: DevModeViewId): SelectionSnapshot {
  return { count: 1, kinds: ['panel'], label: view, ids: [view] };
}

/** §B.3 — the view IS the place: rows → root, Application Data → the sticky child. */
function placePathFor(view: DevModeViewId): readonly string[] {
  return view === DEV_MODE_VIEW_APPLICATION_DATA
    ? [DEV_MODE_EVENTS_PLACE_ID, DEV_MODE_APPLICATION_DATA_PLACE_ID]
    : [DEV_MODE_EVENTS_PLACE_ID];
}

function contextFor(view: DevModeViewId): ContextSnapshot {
  return {
    appId: DEV_MODE_SURFACE_APP_ID,
    placePath: placePathFor(view),
    selection: selectionFor(view),
    dirty: false,
  };
}

/* ───────────────────────────── key tokenisation ───────────────────────────── */

/** `event.key` → a declared bare stroke token, or `null` for anything else. */
function tokenForEvent(event: ReactKeyboardEvent<HTMLElement>): string | null {
  const key = event.key;
  if (key.length !== 1) return null;
  const lower = key.toLowerCase();
  return lower >= 'a' && lower <= 'z' ? lower : null;
}

/**
 * True when the CURRENT place declares the token (or an alias does). The shipped hotkey
 * runtime only intercepted its registered keys, so the adapter preserves that: an unbound
 * letter must reach the page unchanged (no `preventDefault`, no dispatch).
 */
function strokeIsDeclared(host: NavigationHost, token: string): boolean {
  const path = host.getSnapshot().context.placePath;
  const currentId = path[path.length - 1] ?? DEV_MODE_EVENTS_PLACE_ID;
  const place = devModeSurface.tree.places.find((candidate) => candidate.id === currentId);
  if (place !== undefined && place.keys[token] !== undefined) return true;
  return devModeSurface.tree.directAliases[token] !== undefined;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ───────────────────────────── provider ───────────────────────────── */

export interface DevModeNavigationProviderProps {
  /** The active Dev Mode view (`DevMode.tsx` state), projected as the selection + place. */
  readonly view: DevModeViewId;
  /** The live Dev Mode callbacks the verbs delegate to. */
  readonly actions: DevModeActionHandlers | null;
  /** Renders the shipped app root with the ONE adapter attached to its `onKeyDown`. */
  readonly children: (bindings: DevModeNavigationSurfaceBindings) => React.ReactNode;
}

export function DevModeNavigationProvider({
  view,
  actions,
  children,
}: DevModeNavigationProviderProps): React.ReactElement {
  // Latest-value refs so the host (created once) never captures stale props. The view ref is
  // ALSO advanced synchronously by the view verbs below, so `navigationPath` sees the new
  // place in the same dispatch that changed it.
  const viewRef = useRef<DevModeViewId>(view);
  viewRef.current = view;
  const actionsRef = useRef<DevModeActionHandlers | null>(actions);
  actionsRef.current = actions;

  const value = useMemo<DevModeNavigationValue>(() => {
    const host = createNavigationHost({
      surface: devModeSurface,
      getContext: () => contextFor(viewRef.current),
      // UI/UX §7 / §11.5 — adopt the shipped `hotkeys-announcer`; never a second region.
      announcementChannel: 'legacy',
      // Mirror the P5 policy: launcher/voice/agent intents confirm; keyboard/pointer/system
      // keep the shipped no-prompt behaviour (the journal is the undo).
      confirm: (request, intent) =>
        intent.channel === 'launcher' ||
        intent.channel === 'voice' ||
        intent.channel === 'agent'
          ? requestLauncherConfirmation(request, intent)
          : true,
    });
    return { host, surface: devModeSurface };
  }, []);

  // Register for the launcher/composer synchronous registry read; unregister on unmount.
  useEffect(
    () =>
      registerNavigationHost({
        appId: DEV_MODE_SURFACE_APP_ID,
        surface: devModeSurface,
        host: value.host,
      }),
    [value.host],
  );

  // Publish the component's live callbacks to the declaration's verbs. One STABLE wrapper
  // object reads the latest actions ref, so the verb table never holds a stale closure.
  useEffect(() => {
    const handlers: DevModeActionHandlers = {
      clearEvents: () => actionsRef.current?.clearEvents() ?? false,
      focusFilter: () => actionsRef.current?.focusFilter() ?? false,
      showAllStates: () => actionsRef.current?.showAllStates() ?? false,
      showApplicationData: () => {
        const acted = actionsRef.current?.showApplicationData() ?? false;
        if (acted) viewRef.current = DEV_MODE_VIEW_APPLICATION_DATA;
        return acted;
      },
      showRows: () => {
        const acted = actionsRef.current?.showRows() ?? false;
        if (acted) viewRef.current = DEV_MODE_VIEW_ROWS;
        return acted;
      },
    };
    setDevModeActionHandlers(handlers);
    return () => {
      if (getDevModeActionHandlers() === handlers) setDevModeActionHandlers(null);
    };
  }, []);

  // Publish a view change the host did not cause (a pointer toggle running outside a host
  // verb would land here). Value-keyed, so a re-render with the same view is a silent no-op
  // (no epoch advance, no remount, no poll).
  const publishedViewRef = useRef<DevModeViewId>(view);
  useEffect(() => {
    if (publishedViewRef.current === view) return;
    publishedViewRef.current = view;
    viewRef.current = view;
    value.host.refreshContext();
  }, [value.host, view]);

  /* ── the ONE element-scoped key adapter ── */

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // 1 — IME composition.
      if (event.nativeEvent.isComposing) return;
      // 2 — modifier chords never resolve a place stroke.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // 3 — the map dialog owns its own keys.
      if (value.host.getSnapshot().mapOpen) return;

      const target = event.target instanceof Element ? event.target : null;
      // 4 — an open modal owns the keyboard.
      if (target !== null && target.closest('[aria-modal="true"]') !== null) return;
      // 5 — typing in a field is never a stroke.
      if (isTextControl(target)) return;
      // 6 — a control already handled the key.
      if (event.defaultPrevented) return;

      // 7 — `[a-z]` token; an unbound letter is not ours (no preventDefault, no dispatch).
      const token = tokenForEvent(event);
      if (token === null || !strokeIsDeclared(value.host, token)) return;

      event.preventDefault();
      // 8 — dispatch synchronously inside this keydown task.
      void value.host.handleStroke(token, nowMs());
    },
    [value.host],
  );

  /** Pointer view toggle → the SAME declared verb (one dispatch funnel, `channel:'pointer'`). */
  const runView = useCallback(
    (nextView: DevModeViewId) => {
      const verbId =
        nextView === DEV_MODE_VIEW_APPLICATION_DATA
          ? DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID
          : DEV_MODE_VIEW_ROWS_VERB_ID;
      void value.host.runVerb(verbId, 'pointer');
    },
    [value.host],
  );

  const bindings = useMemo<DevModeNavigationSurfaceBindings>(
    () => ({ onKeyDown: handleKeyDown, runView }),
    [handleKeyDown, runView],
  );

  return (
    <DevModeNavigationContext.Provider value={value}>
      {children(bindings)}
    </DevModeNavigationContext.Provider>
  );
}

/** The provider's host + surface; throws when used outside a Dev Mode window. */
export function useDevModeNavigation(): DevModeNavigationValue {
  const value = useContext(DevModeNavigationContext);
  if (value === null) {
    throw new Error('useDevModeNavigation must be used inside DevModeNavigationProvider');
  }
  return value;
}

/* ───────────────────────────── footer (§2 / §3) ───────────────────────────── */

/**
 * The shared bottom footer: the shipped `CommandRail` / `ActivityTrail` / `NavigationMap`
 * over the ONE projection layer. Rendered by `DevMode` as the app root's LAST flex child
 * (Architect §B.2 / UI/UX §3); no root restructure and no new DOM hook.
 */
export function DevModeNavigationFooter(): React.ReactElement {
  const { host, surface } = useDevModeNavigation();
  const snapshot = useNavigationHostSnapshot(host);

  // The host snapshot's context is already fresh (the active view publishes through the
  // synchronous view ref + `refreshContext`), so the three projections read ONE source.
  const railModel = useMemo(
    () => buildCommandRailModel(surface, snapshot.context),
    [surface, snapshot.context],
  );
  const mapModel = useMemo(
    () =>
      buildNavigationMapModel(surface, snapshot.context, {
        filteredTo: snapshot.mapFilterPlaceId,
      }),
    [surface, snapshot.context, snapshot.mapFilterPlaceId],
  );
  const trailModel = useMemo(
    () => buildActivityTrailModel(surface, snapshot.entries),
    [surface, snapshot.entries],
  );

  /** Rail/map row activation — one dispatch funnel, `channel:'pointer'`. */
  const runPointerVerb = useCallback(
    (verbId: string) => {
      if (verbId === 'app.map') {
        host.openMap(null);
        return;
      }
      void host.runVerb(verbId, 'pointer');
    },
    [host],
  );

  const openMap = useCallback(
    (filterPlaceId?: string | null) => host.openMap(filterPlaceId ?? null),
    [host],
  );
  const closeMap = useCallback(() => host.closeMap(), [host]);
  const undo = useCallback(
    (seq: number) => {
      void host.undoEntry(seq);
    },
    [host],
  );
  const openComposer = useCallback(() => {
    requestCompanionComposerOpen({
      source: 'command-bar-ask',
      appId: DEV_MODE_SURFACE_APP_ID,
      focus: true,
    });
  }, []);

  return (
    <Flex
      flexShrink={0}
      w="100%"
      minW="0"
      flexWrap="wrap"
      alignItems="stretch"
      bg="bg.surface"
      borderTopWidth="1px"
      borderColor="border.default"
    >
      <Flex flex="1 1 520px" minW="0">
        <CommandRail
          model={railModel}
          onRunVerb={runPointerVerb}
          onOpenMap={openMap}
          onAsk={openComposer}
        />
      </Flex>
      <Flex
        flexShrink={0}
        w={{ base: '100%', lg: '320px' }}
        maxH="140px"
        overflowY="auto"
        borderTopWidth="1px"
        borderColor="border.default"
      >
        <ActivityTrail model={trailModel} compact onUndo={undo} />
      </Flex>
      <NavigationMap
        model={mapModel}
        open={snapshot.mapOpen}
        onClose={closeMap}
        onRunVerb={runPointerVerb}
      />
    </Flex>
  );
}
