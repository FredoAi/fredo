/**
 * Terminal navigation provider (Spec #3121, ST-1).
 *
 * Creates the ONE NavigationEngine host for the Terminal application, registers it for the
 * synchronous registry reads (`describeContext`), owns the terminal's passthrough seam
 * (Architect §B.7) and renders the app root plus the shared bottom footer.
 *
 * Follows the P5 `WireframeNavigationProvider` pattern exactly:
 *   - the host is built in `useMemo` (no timers, no I/O);
 *   - `registerNavigationHost` runs in a mount effect and returns its disposer;
 *   - a context change publishes through `host.refreshContext()` (only on a REAL change);
 *   - ONE element-scoped `onKeyDown` on the app root — never a `document` keydown listener,
 *     never a poll.
 *
 * PASSTHROUGH (§B.7, the load-bearing invariant):
 *   - focus-in inside `[data-fredo-terminal-root="true"]` → `terminal.session.enter`
 *     (`channel:'system'`) → exactly ONE navigation journal entry;
 *   - while focused, every stroke goes to `host.handleStroke(stroke, nowMs,
 *     { keyboardOwner:'terminal' })`, which resolves to `passthrough`; the adapter NEVER
 *     calls `preventDefault`/`stopPropagation`, adds no `await`, no IPC and no React state
 *     write before the PTY — the keystroke reaches the shell unchanged;
 *   - focus-out → `place.exit`, exactly ONE pop back to `terminal.window`.
 *   Enter/exit are idempotent and coalesced on a microtask (the shipped `scheduleSync`
 *   pattern in `terminalMode.ts`), so an intra-terminal focus move never flaps the cursor.
 *
 * `installTerminalPassthrough` (the body hook + the one-time announcement) stays installed by
 * `TerminalWindow`; this provider adds NO second focus/animation/announcement region.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Flex } from '@chakra-ui/react';

import {
  PLACE_EXIT_VERB_ID,
  type ContextSnapshot,
  type SelectionSnapshot,
  type Surface,
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
import { TERMINAL_ROOT_SELECTOR, isTerminalFocused } from '../../../shared/hotkeys/terminalMode';
import {
  TERMINAL_SESSION_ENTER_VERB_ID,
  TERMINAL_SESSION_PLACE_ID,
  TERMINAL_SURFACE_APP_ID,
  TERMINAL_WINDOW_PLACE_ID,
  getTerminalActionHandlers,
  setTerminalActionHandlers,
  terminalSurface,
  type TerminalActionHandlers,
} from '../terminalSurface';

/* ───────────────────────────── context ───────────────────────────── */

export interface TerminalNavigationValue {
  readonly host: NavigationHost;
  readonly surface: Surface;
}

const TerminalNavigationContext = createContext<TerminalNavigationValue | null>(null);

const EMPTY_SELECTION: SelectionSnapshot = Object.freeze({
  count: 0,
  kinds: [],
  label: null,
  ids: [],
});

function selectionOf(
  sessionId: string | null,
  sessionLabel: string | null,
): SelectionSnapshot {
  if (sessionId === null) return EMPTY_SELECTION;
  return { count: 1, kinds: ['session'], label: sessionLabel, ids: [sessionId] };
}

/**
 * The injected read model (§D.4).
 *
 * `placePath` is the FOCUS-derived external path: while the PTY owns the keyboard the cursor
 * belongs at `terminal.session`; otherwise at the root. The host keeps its own cursor and only
 * adopts this path for a navigation effect the declaration cannot resolve itself (`terminal.
 * session.enter` is not a place id, so the host's `navigationPath` uses the external path —
 * host.ts:373-381). That is how focus-in enters the child without a second cursor authority.
 */
function terminalContext(
  focused: boolean,
  selection: SelectionSnapshot,
): ContextSnapshot {
  return {
    appId: TERMINAL_SURFACE_APP_ID,
    placePath: focused
      ? [TERMINAL_WINDOW_PLACE_ID, TERMINAL_SESSION_PLACE_ID]
      : [TERMINAL_WINDOW_PLACE_ID],
    selection,
    dirty: false,
  };
}

/* ───────────────────────────── provider ───────────────────────────── */

export interface TerminalNavigationProviderProps {
  /** The selected session id (`TerminalWindow.tsx:80`), published as the selection. */
  readonly selectedSessionId?: string | null;
  /** The selected session's display name (the selection label). */
  readonly selectedSessionLabel?: string | null;
  /** The live window callbacks the action verbs delegate to. */
  readonly actions?: TerminalActionHandlers | null;
  readonly children?: React.ReactNode;
}

export function TerminalNavigationProvider({
  selectedSessionId = null,
  selectedSessionLabel = null,
  actions = null,
  children,
}: TerminalNavigationProviderProps): React.ReactElement {
  // Latest-value refs so the host (created once) never captures stale props and the handler
  // wrapper always calls the CURRENT window closures.
  const focusedRef = useRef(false);
  const selectionRef = useRef<SelectionSnapshot>(EMPTY_SELECTION);
  selectionRef.current = selectionOf(selectedSessionId, selectedSessionLabel);
  const actionsRef = useRef<TerminalActionHandlers | null>(actions);
  actionsRef.current = actions;

  const value = useMemo<TerminalNavigationValue>(() => {
    const host = createNavigationHost({
      surface: terminalSurface,
      getContext: () => terminalContext(focusedRef.current, selectionRef.current),
      // §11.5 / UI/UX §7 — adopt the shipped `hotkeys-announcer`; never add a second region.
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
    return { host, surface: terminalSurface };
    // The host is the ONE stable seam for this mount; the refs above keep the injected
    // values current without re-creating the host.
  }, []);

  // Register for the launcher/composer synchronous registry read; unregister on unmount.
  useEffect(
    () =>
      registerNavigationHost({
        appId: TERMINAL_SURFACE_APP_ID,
        surface: terminalSurface,
        host: value.host,
      }),
    [value.host],
  );

  // Publish the window's live callbacks to the declaration's action verbs. One STABLE wrapper
  // object reads the latest actions ref, so the verb table never holds a stale closure.
  useEffect(() => {
    const handlers: TerminalActionHandlers = {
      newSession: () => actionsRef.current?.newSession() ?? false,
      closeSession: (id) => actionsRef.current?.closeSession(id) ?? false,
      openRename: (id) => actionsRef.current?.openRename(id) ?? false,
      renameSession: (id, name) => actionsRef.current?.renameSession(id, name) ?? false,
      resumeSession: (id) => actionsRef.current?.resumeSession(id) ?? false,
      startFresh: (id) => actionsRef.current?.startFresh(id) ?? false,
      retrySession: (id) => actionsRef.current?.retrySession(id) ?? false,
      chooseDirectory: (id) => actionsRef.current?.chooseDirectory(id) ?? false,
      deleteRecord: (id) => actionsRef.current?.deleteRecord(id) ?? false,
      copyAuthCommand: () => actionsRef.current?.copyAuthCommand() ?? false,
    };
    setTerminalActionHandlers(handlers);
    return () => {
      if (getTerminalActionHandlers() === handlers) setTerminalActionHandlers(null);
    };
  }, []);

  // ST-1-R3 analogue — a selection change the host did not cause (a pointer row select) is
  // published through `refreshContext()`. Value-keyed, so a re-render with the same selection
  // is a silent no-op (no epoch advance, no remount, no poll).
  const selectionKey = `${selectedSessionId ?? ''}|${selectedSessionLabel ?? ''}`;
  const publishedKeyRef = useRef(selectionKey);
  useEffect(() => {
    if (publishedKeyRef.current === selectionKey) return;
    publishedKeyRef.current = selectionKey;
    value.host.refreshContext();
  }, [value.host, selectionKey]);

  /* ── §B.7 focus transitions (microtask-coalesced; idempotent) ── */

  const syncScheduledRef = useRef(false);

  const syncFocus = useCallback(() => {
    const host = value.host;
    const active = isTerminalFocused();
    if (active === focusedRef.current) return;
    // Publish the new owner BEFORE dispatch so `navigationPath` reads the entering path.
    focusedRef.current = active;
    const path = host.getSnapshot().context.placePath;
    const insideSession = path[path.length - 1] === TERMINAL_SESSION_PLACE_ID;
    if (active) {
      if (insideSession) return;
      void host.runIntent({
        verbId: TERMINAL_SESSION_ENTER_VERB_ID,
        args: {},
        channel: 'system',
        actor: 'system',
      });
      return;
    }
    if (!insideSession) return;
    void host.runIntent({
      verbId: PLACE_EXIT_VERB_ID,
      args: {},
      channel: 'system',
      actor: 'system',
    });
  }, [value.host]);

  const scheduleFocusSync = useCallback(() => {
    if (syncScheduledRef.current) return;
    syncScheduledRef.current = true;
    queueMicrotask(() => {
      syncScheduledRef.current = false;
      syncFocus();
    });
  }, [syncFocus]);

  const handleFocusChange = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      // Only a transition INTO or OUT OF the PTY anchor matters; focus inside the footer or a
      // dialog never moves the passthrough cursor.
      if (target === null || target.closest(TERMINAL_ROOT_SELECTOR) === null) return;
      scheduleFocusSync();
    },
    [scheduleFocusSync],
  );

  /* ── the ONE element-scoped key adapter (§B.7 / R-05) ── */

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // Not the PTY's keyboard ⇒ the app declares no keys, so nothing is dispatched.
      if (!isTerminalFocused()) return;
      void value.host.handleStroke(event.key, nowMs(), { keyboardOwner: 'terminal' });
      // NEVER preventDefault / stopPropagation here: the stroke belongs to the shell.
    },
    [value.host],
  );

  return (
    <TerminalNavigationContext.Provider value={value}>
      <Flex
        direction="column"
        h="100%"
        minH={0}
        w="100%"
        bg="bg.canvas"
        position="relative"
        onKeyDown={handleKeyDown}
        onFocus={handleFocusChange}
        onBlur={handleFocusChange}
      >
        {children}
      </Flex>
    </TerminalNavigationContext.Provider>
  );
}

/** The provider's host + surface; throws when used outside a Terminal window. */
export function useTerminalNavigation(): TerminalNavigationValue {
  const value = useContext(TerminalNavigationContext);
  if (value === null) {
    throw new Error('useTerminalNavigation must be used inside TerminalNavigationProvider');
  }
  return value;
}

/* ───────────────────────────── footer (§2 / §3) ───────────────────────────── */

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * The shared bottom footer: the shipped `CommandRail` / `ActivityTrail` / `NavigationMap`
 * over the ONE projection layer. Rendered as the app root's LAST flex child (Architect §B.2 /
 * UI/UX §3) with the terminal's trail delta (`maxH 96`, xterm keeps its height).
 */
export function TerminalNavigationFooter(): React.ReactElement {
  const { host, surface } = useTerminalNavigation();
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
      appId: TERMINAL_SURFACE_APP_ID,
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
        maxH="96px"
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
