/**
 * SQL Studio (`database-client`) navigation provider (Spec #3121, ST-4).
 *
 * Mounted by `DatabaseClientFeature.render()` around `DatabaseClientFeatureView` (Architect
 * §B.2 / UI/UX §3.1) and follows the P5 `WireframeNavigationProvider` pattern exactly:
 *
 *   - ONE host, created in `useMemo` (no timers, no I/O, no storage);
 *   - `registerNavigationHost` in a mount effect, returning its disposer;
 *   - selection changes publish through `host.refreshContext()` on a REAL value change
 *     (the view calls `publishSelection`; no remount, no poll, no `.length` dependency);
 *   - ONE element-scoped adapter (`handleDatabaseClientKeyDown`) attached to the app root by
 *     the view — never a `document` keydown listener. SQL Studio declares ZERO keys, so the
 *     adapter never intercepts a stroke: in particular `Ctrl/Cmd+Enter` reaches `SqlEditor`
 *     untouched (D-3(b)).
 *
 * The footer (`DatabaseClientNavigationFooter`) is the shipped `CommandRail` + `ActivityTrail`
 * + `NavigationMap` over this surface's declaration; the VIEW renders it as the third and last
 * flex child of the shipped `db-client-root` column, after the status strip (UI/UX §3.1) — no
 * wrapper, no layout restructure, no new testid.
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
import { isTextControl } from '../../../shared/hotkeys/focusContext';
import {
  DATABASE_CLIENT_SURFACE_APP_ID,
  SQL_STUDIO_WORKSPACE_PLACE_ID,
  databaseClientSurface,
} from '../databaseClientSurface';

/* ───────────────────────────── context ───────────────────────────── */

export interface DatabaseClientNavigationValue {
  readonly host: NavigationHost;
  readonly surface: Surface;
  /**
   * Publish the view's live selection. A value-identical selection is a silent no-op; a real
   * change advances the host epoch once and re-derives availability WITHOUT moving the cursor
   * (D-UI-1) and without a remount.
   */
  readonly publishSelection: (selection: SelectionSnapshot) => void;
}

const DatabaseClientNavigationContext =
  createContext<DatabaseClientNavigationValue | null>(null);

export interface DatabaseClientNavigationProviderProps {
  readonly children?: React.ReactNode;
}

const EMPTY_SELECTION: SelectionSnapshot = Object.freeze({
  count: 0,
  kinds: [],
  label: null,
  ids: [],
});

function sameSelection(left: SelectionSnapshot, right: SelectionSnapshot): boolean {
  if (left.count !== right.count || left.label !== right.label) return false;
  if (left.kinds.length !== right.kinds.length || left.ids.length !== right.ids.length) return false;
  return (
    left.kinds.every((kind, index) => kind === right.kinds[index]) &&
    left.ids.every((id, index) => id === right.ids[index])
  );
}

/** The injected read model (§D.4). `placePath` mirrors the host cursor (never a second authority). */
function sqlStudioContext(
  selection: SelectionSnapshot,
  placePath: readonly string[],
): ContextSnapshot {
  return {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    placePath,
    selection,
    dirty: false,
  };
}

/**
 * Create + provide the ONE SQL Studio navigation host.
 *
 * The host is built in `useMemo` (no timers, no storage). `getContext` reports the selection
 * ref plus the CURRENT host cursor (read through `hostRef`), so an action verb's navigation
 * effect never re-seats the cursor onto the root (D-UI-1: selection never moves the place).
 */
export function DatabaseClientNavigationProvider({
  children,
}: DatabaseClientNavigationProviderProps): React.ReactElement {
  const selectionRef = useRef<SelectionSnapshot>(EMPTY_SELECTION);
  const hostRef = useRef<NavigationHost | null>(null);

  const value = useMemo<DatabaseClientNavigationValue>(() => {
    const host = createNavigationHost({
      surface: databaseClientSurface,
      getContext: () =>
        sqlStudioContext(
          selectionRef.current,
          hostRef.current?.getSnapshot().context.placePath ?? [SQL_STUDIO_WORKSPACE_PLACE_ID],
        ),
      // UI/UX §7 / §11.5 — adopt the shipped `hotkeys-announcer`; never add a second region.
      announcementChannel: 'legacy',
      // P5 parity: launcher/voice/agent intents confirm; keyboard/pointer keep the shipped
      // no-prompt behaviour (the journal is the attribution/undo record).
      confirm: (request, intent) =>
        intent.channel === 'launcher' ||
        intent.channel === 'voice' ||
        intent.channel === 'agent'
          ? requestLauncherConfirmation(request, intent)
          : true,
    });
    hostRef.current = host;

    const publishSelection = (next: SelectionSnapshot): void => {
      if (sameSelection(selectionRef.current, next)) return;
      selectionRef.current = next;
      host.refreshContext();
    };

    return { host, surface: databaseClientSurface, publishSelection };
  }, []);

  // Register for the launcher/composer synchronous registry read; unregister on unmount.
  useEffect(
    () =>
      registerNavigationHost({
        appId: DATABASE_CLIENT_SURFACE_APP_ID,
        surface: databaseClientSurface,
        host: value.host,
      }),
    [value.host],
  );

  return (
    <DatabaseClientNavigationContext.Provider value={value}>
      {children}
    </DatabaseClientNavigationContext.Provider>
  );
}

/** The provider's host + surface; throws when used outside a SQL Studio mount. */
export function useDatabaseClientNavigation(): DatabaseClientNavigationValue {
  const value = useContext(DatabaseClientNavigationContext);
  if (value === null) {
    throw new Error(
      'useDatabaseClientNavigation must be used inside DatabaseClientNavigationProvider',
    );
  }
  return value;
}

/**
 * The optional form: `DatabaseClientFeatureView` is also rendered bare by the pre-migration
 * suites, so the view reads the provider without requiring it (no footer / no adapter then).
 * The product path always mounts the provider through `DatabaseClientFeature.render()`.
 */
export function useOptionalDatabaseClientNavigation(): DatabaseClientNavigationValue | null {
  return useContext(DatabaseClientNavigationContext);
}

/* ───────────────────────────── the ONE key adapter ───────────────────────────── */

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Normalise `event.key` to a declared stroke token. SQL Studio declares no key, so this is a
 * truthful closed-surface adapter: it only ever forwards a stroke that IS bound in the current
 * place (never an "unavailable key" announcement for ordinary typing).
 */
function tokenForEvent(event: ReactKeyboardEvent<HTMLElement>): string | null {
  const key = event.key;
  if (key === 'Escape') return 'Escape';
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return lower;
  }
  return null;
}

/**
 * The ONE element-scoped SQL Studio key adapter (attached to `db-client-root`'s `onKeyDown`).
 *
 * It is deliberately inert for this declaration (zero place keys): `Ctrl/Cmd+Enter` is filtered
 * out BEFORE any host call so the text-entry owner (`SqlEditor`) keeps the chord exactly as
 * shipped (D-3(b)), and a stroke with no binding is never dispatched (no spurious announcement).
 */
export function handleDatabaseClientKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  host: NavigationHost,
  nowMsValue: number = nowMs(),
): void {
  // 1 — IME composition.
  if (event.nativeEvent.isComposing) return;
  // 2 — modifier chords belong to their owners (`Ctrl/Cmd+Enter` → SqlEditor, D-3(b)).
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // 3 — the map dialog owns its own keys.
  if (host.getSnapshot().mapOpen) return;

  const target = event.target instanceof Element ? event.target : null;
  // 4 — a modal dialog.
  if (target !== null && target.closest('[aria-modal="true"]') !== null) return;
  // 5 — typing in a field is never a stroke.
  if (isTextControl(target)) return;
  // 6 — a control already handled the key.
  if (event.defaultPrevented) return;

  const token = tokenForEvent(event);
  if (token === null) return;

  // 7 — only a DECLARED key of the current place is a stroke (SQL Studio declares none).
  const path = host.getSnapshot().context.placePath;
  const currentId = path[path.length - 1];
  const currentPlace = databaseClientSurface.tree.places.find(
    (place) => place.id === currentId,
  );
  if (currentPlace === undefined || currentPlace.keys[token] === undefined) return;

  event.preventDefault();
  void host.handleStroke(token, nowMsValue);
}

/* ───────────────────────────── footer (§2 / §3.1) ───────────────────────────── */

/**
 * The shared bottom footer: the shipped `CommandRail` / `ActivityTrail` / `NavigationMap` over
 * the ONE projection layer. Rendered by the VIEW as the third and last flex child of the
 * shipped `db-client-root` column (after the status strip) — `flexShrink 0`, no layout box of
 * its own beyond the strip, and NO new testid (UI/UX §3.1(b)/(e)).
 */
export function DatabaseClientNavigationFooter(): React.ReactElement {
  const { host, surface } = useDatabaseClientNavigation();
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
      appId: DATABASE_CLIENT_SURFACE_APP_ID,
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
