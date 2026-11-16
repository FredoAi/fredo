/**
 * Mission Monitor navigation provider (Spec #3121, ST-3).
 *
 * Creates the ONE NavigationEngine host for the Mission Monitor application, registers it for
 * the synchronous registry reads (`describeContext`), owns the ONE element-scoped key adapter
 * and renders the shared bottom footer (`CommandRail` + `ActivityTrail` + `NavigationMap`).
 *
 * Follows the P5 `WireframeNavigationProvider` / P7 `TerminalNavigationProvider` pattern:
 *   - the host is built in `useMemo` (no timers, no I/O);
 *   - `registerNavigationHost` runs in a mount effect and returns its disposer;
 *   - a selection change publishes through `host.refreshContext()` (only on a REAL value
 *     change — value-keyed, so an equal re-render is a silent no-op);
 *   - ONE element-scoped `onKeyDown` wrapper — never a `document` keydown listener, never a
 *     poll. The wrapper is `display: contents`, so it adds no layout box: the panel root keeps
 *     its exact geometry (Architect §B.2 / UI/UX §3).
 *
 * `s` is the ONE stroke the shipped UI declared. It focuses the session filter input and
 * no-ops when the drawer is collapsed (the input is not mounted) — behaviour preservation, not
 * a new capability. `Escape` is deliberately NOT tokenised here: the shipped detail-panel
 * `Escape` window listeners (`DetailPanel.tsx:314-328`, `:343-349`) remain the one close path.
 *
 * Announcement channel: `legacy` — the navigation channel ADOPTS the shipped `hotkeys-announcer`
 * region; no second live region is added.
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

import type {
  ContextSnapshot,
  SelectionSnapshot,
  Surface,
} from '../../../shared/navigation';
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
import { isTextControl } from '../../../shared/navigation/focusContext';
import {
  MISSION_MONITOR_SESSIONS_PLACE_ID,
  MISSION_MONITOR_SURFACE_APP_ID,
  getMissionMonitorActionHandlers,
  missionMonitorSurface,
  setMissionMonitorActionHandlers,
  type MissionMonitorActionHandlers,
} from '../missionMonitorSurface';

/* ───────────────────────────── context ───────────────────────────── */

export interface MissionMonitorNavigationValue {
  readonly host: NavigationHost;
  readonly surface: Surface;
}

const MissionMonitorNavigationContext =
  createContext<MissionMonitorNavigationValue | null>(null);

const EMPTY_SELECTION: SelectionSnapshot = Object.freeze({
  count: 0,
  kinds: [],
  label: null,
  ids: [],
});

/** Architect §D.4 — the selection projects the panel's `selectedSessionId`. */
function selectionOf(
  sessionId: string | null,
  sessionLabel: string | null,
): SelectionSnapshot {
  if (sessionId === null) return EMPTY_SELECTION;
  return { count: 1, kinds: ['session'], label: sessionLabel, ids: [sessionId] };
}

/** The injected read model: the root place path plus the live selection. */
function missionMonitorContext(selection: SelectionSnapshot): ContextSnapshot {
  return {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    placePath: [MISSION_MONITOR_SESSIONS_PLACE_ID],
    selection,
    dirty: false,
  };
}

/* ───────────────────────────── provider ───────────────────────────── */

export interface MissionMonitorNavigationProviderProps {
  /** The panel's `selectedSessionId`, published as the selection. */
  readonly selectedSessionId?: string | null;
  /** The selected session's display name (the selection label). */
  readonly selectedSessionLabel?: string | null;
  /** The live panel callbacks the action verbs delegate to. */
  readonly actions?: MissionMonitorActionHandlers | null;
  readonly children?: React.ReactNode;
}

export function MissionMonitorNavigationProvider({
  selectedSessionId = null,
  selectedSessionLabel = null,
  actions = null,
  children,
}: MissionMonitorNavigationProviderProps): React.ReactElement {
  // Latest-value refs so the host (created once) never captures stale props and the handler
  // wrapper always calls the CURRENT panel closures.
  const selectionRef = useRef<SelectionSnapshot>(EMPTY_SELECTION);
  selectionRef.current = selectionOf(selectedSessionId, selectedSessionLabel);
  const actionsRef = useRef<MissionMonitorActionHandlers | null>(actions);
  actionsRef.current = actions;

  const value = useMemo<MissionMonitorNavigationValue>(() => {
    const host = createNavigationHost({
      surface: missionMonitorSurface,
      getContext: () => missionMonitorContext(selectionRef.current),
      // §11.5 / UI/UX §7 — adopt the shipped `hotkeys-announcer`; never add a second region.
      // Mirror the P5 policy: launcher/voice/agent intents confirm; keyboard/pointer keep the
      // shipped no-prompt behaviour (the journal is the undo).
      confirm: (request, intent) =>
        intent.channel === 'launcher' ||
        intent.channel === 'voice' ||
        intent.channel === 'agent'
          ? requestLauncherConfirmation(request, intent)
          : true,
    });
    return { host, surface: missionMonitorSurface };
  }, []);

  // Register for the launcher/composer synchronous registry read; unregister on unmount.
  useEffect(
    () =>
      registerNavigationHost({
        appId: MISSION_MONITOR_SURFACE_APP_ID,
        surface: missionMonitorSurface,
        host: value.host,
      }),
    [value.host],
  );

  // Publish the panel's live callbacks to the declaration's action verbs through ONE stable
  // wrapper that reads the latest actions ref (the verb table never holds a stale closure).
  useEffect(() => {
    const handlers: MissionMonitorActionHandlers = {
      focusSearch: () => actionsRef.current?.focusSearch() ?? false,
      toggleDrawer: () => actionsRef.current?.toggleDrawer() ?? false,
      deleteSession: (sessionId) =>
        actionsRef.current?.deleteSession(sessionId) ?? false,
      closeDetail: () => actionsRef.current?.closeDetail() ?? false,
    };
    setMissionMonitorActionHandlers(handlers);
    return () => {
      if (getMissionMonitorActionHandlers() === handlers) {
        setMissionMonitorActionHandlers(null);
      }
    };
  }, []);

  // ST-1-R3 analogue — a selection change the host did not cause (a pointer row select) is
  // published through `refreshContext()`. Value-keyed, so an equal re-render is a silent no-op
  // (no epoch advance, no remount, no poll).
  const selectionKey = `${selectedSessionId ?? ''}|${selectedSessionLabel ?? ''}`;
  const publishedKeyRef = useRef(selectionKey);
  useEffect(() => {
    if (publishedKeyRef.current === selectionKey) return;
    publishedKeyRef.current = selectionKey;
    value.host.refreshContext();
  }, [value.host, selectionKey]);

  // ONE element-scoped key adapter. `s` is the only declared stroke; an unbound token resolves
  // to a hint and dispatches nothing. preventDefault runs only for a tokenised bindable stroke,
  // synchronously before the host call (the shipped Wireframe adapter shape).
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (value.host.getSnapshot().mapOpen) return;

      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && target.closest('[aria-modal="true"]') !== null) return;
      if (isTextControl(target)) return;
      if (event.defaultPrevented) return;

      const token = tokenForEvent(event);
      if (token === null) return;

      event.preventDefault();
      void value.host.handleStroke(token, nowMs());
    },
    [value.host],
  );

  return (
    <MissionMonitorNavigationContext.Provider value={value}>
      {/* `display: contents` — the panel root keeps its exact geometry (no extra box). */}
      <div style={{ display: 'contents' }} onKeyDown={handleKeyDown}>
        {children}
      </div>
    </MissionMonitorNavigationContext.Provider>
  );
}

/** The provider's host + surface; throws when used outside a Mission Monitor panel. */
export function useMissionMonitorNavigation(): MissionMonitorNavigationValue {
  const value = useContext(MissionMonitorNavigationContext);
  if (value === null) {
    throw new Error(
      'useMissionMonitorNavigation must be used inside MissionMonitorNavigationProvider',
    );
  }
  return value;
}

/* ───────────────────────────── key adapter helpers ───────────────────────────── */

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Normalise `event.key` to a declared stroke token. Only the bindable bare alphabet/digit
 * grammar is tokenised — Mission Monitor binds no reserved stroke (the shipped `Escape`
 * detail-close listener is a window listener, not an engine stroke).
 */
function tokenForEvent(event: ReactKeyboardEvent<HTMLElement>): string | null {
  const key = event.key;
  if (key.length !== 1) return null;
  const lower = key.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return lower;
  if (lower >= '0' && lower <= '9') return lower;
  return null;
}

/* ───────────────────────────── footer (§2 / §3) ───────────────────────────── */

/**
 * The shared bottom footer: the shipped `CommandRail` / `ActivityTrail` / `NavigationMap` over
 * the ONE projection layer. Rendered as the panel root's LAST flex child, after the drawer +
 * canvas body (Architect §B.2 / UI/UX §3) — the root already is a column, so no restructure.
 */
export function MissionMonitorNavigationFooter(): React.ReactElement {
  const { host, surface } = useMissionMonitorNavigation();
  const snapshot = useNavigationHostSnapshot(host);

  // The host snapshot's context is already fresh (selection publishes through
  // `refreshContext`), so the three projections read the ONE source of truth.
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
      appId: MISSION_MONITOR_SURFACE_APP_ID,
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
