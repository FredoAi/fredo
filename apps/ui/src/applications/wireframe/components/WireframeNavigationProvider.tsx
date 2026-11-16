/**
 * Wireframe navigation provider (Spec #3119, ST-4).
 *
 * Creates the ONE NavigationEngine host for the Wireframe application, exposes it to the
 * shell, and owns the ONE element-scoped key adapter (no document listener, no second
 * dispatcher). The host is the only mutation seam: the rail, the map, the trail and the
 * keyboard all funnel through it, so the journal stays the single undo authority (R-5).
 *
 * Announcement: the ONE navigation live region is owned by `NavigationProvider` at the
 * webview root (Spec #3122 ST-2). This provider neither mounts an announcer nor selects a
 * channel; every navigation message goes through `announceNavigation`.
 *
 * Placement: the provider is a plain React context + `useMemo`; it adds no DOM and no
 * keydown listener of its own. The adapter is returned to the shell, which attaches it to
 * the shell root's `onKeyDown` — exactly one handler, element-scoped, synchronous up to
 * `host.handleStroke`.
 *
 * NFR: the canvas must never subscribe to the journal. `useWireframePlaceView` returns a
 * cached place slice (`placeId`/`label`/`cursor`/`operator`/`transient`/`armed`) whose
 * object identity only changes when one of those values changes — a journal append that
 * does not move the cursor or the armed kind does not re-render its consumer.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { Channel, ContextSnapshot, DispatchResult } from '../../../shared/navigation';
import {
  createNavigationHost,
  registerNavigationHost,
  requestLauncherConfirmation,
  useNavigationHostSnapshot,
  type NavigationHost,
} from '../../../shared/navigation/ui';
import { isTextControl } from '../../../shared/navigation/focusContext';
import {
  applyDocumentPatch,
  getNavigationJournal,
  getSnapshot,
  getWireframeContext,
  setWireframeContextProvider,
  subscribe,
  type WireframeDocumentPatch,
} from '../store/wireframeDocumentStore';
import {
  WIREFRAME_ROOT_PLACE_ID,
  WIREFRAME_SURFACE_APP_ID,
  getArmedWireframeShape,
  subscribeArmedWireframeShape,
  wireframeSurface,
} from '../wireframeSurface';
import type { Surface } from '../../../shared/navigation';

/* ───────────────────────────── context ───────────────────────────── */

export interface WireframeNavigationValue {
  readonly host: NavigationHost;
  readonly surface: Surface;
}

const WireframeNavigationContext = createContext<WireframeNavigationValue | null>(null);

export interface WireframeNavigationProviderProps {
  readonly children?: React.ReactNode;
}

/**
 * Create + provide the ONE Wireframe navigation host.
 *
 * The host is built with the module-scoped journal and `applyDocumentPatch`, so every
 * completed verb writes exactly one journal entry and the store's `undo` shims read the
 * SAME stack. `confirm` gates only the launcher/voice/agent channels through the launcher
 * confirmation store; keyboard/pointer human intents keep the shipped no-confirm
 * behaviour (the journal is the undo).
 */
export function WireframeNavigationProvider({
  children,
}: WireframeNavigationProviderProps): React.ReactElement {
  const value = useMemo<WireframeNavigationValue>(() => {
    const host = createNavigationHost({
      surface: wireframeSurface,
      getContext: getWireframeContext,
      journal: getNavigationJournal(),
      applyPatch: (patch) =>
        applyDocumentPatch(patch as unknown as WireframeDocumentPatch),
      // Spec #3120 (P6) §9.1 — launcher/voice/agent intents ask the launcher to confirm;
      // keyboard/pointer keep the shipped no-prompt behaviour.
      confirm: (request, intent) =>
        intent.channel === 'launcher' ||
        intent.channel === 'voice' ||
        intent.channel === 'agent'
          ? requestLauncherConfirmation(request, intent)
          : true,
    });
    return { host, surface: wireframeSurface };
  }, []);

  // Spec #3120 (P6) — register the host for the launcher's synchronous registry read
  // (`getNavigationHost` / `describeContext`); unregister on unmount.
  useEffect(
    () =>
      registerNavigationHost({
        appId: WIREFRAME_SURFACE_APP_ID,
        surface: wireframeSurface,
        host: value.host,
      }),
    [value.host],
  );

  // Spec #3120 (P6), ST-4-R3 — publish the store's context changes to the host. A store-only
  // selection/dirty change (pointer select, empty-stage deselect) never reaches a host
  // mutation, so without this the launcher memo's epoch stays put and the header/grounding
  // envelope keep the stale context. The cheap pre-filter keeps the pan/zoom hot path (every
  // `setView` notifies) off the host: the selection array reference is stable until it really
  // changes, and `dirty` is a primitive. Re-subscribes on mount because the store's test reset
  // REPLACES the listener set.
  useEffect(() => {
    const host = value.host;
    let selectedIds = getSnapshot().selectedIds;
    let dirty = getSnapshot().dirty;
    return subscribe(() => {
      const snapshot = getSnapshot();
      if (snapshot.selectedIds === selectedIds && snapshot.dirty === dirty) return;
      selectedIds = snapshot.selectedIds;
      dirty = snapshot.dirty;
      host.refreshContext();
    });
  }, [value.host]);

  // Publish the host-owned place path to the store's read model. The store always
  // overrides `selection`/`dirty` with its live values; only `appId`/`placePath` are read.
  useEffect(() => {
    setWireframeContextProvider(() => ({
      appId: WIREFRAME_SURFACE_APP_ID,
      placePath: value.host.getSnapshot().context.placePath,
      selection: { count: 0, ids: [], kinds: [], label: null },
      dirty: false,
    }));
    return () => {
      setWireframeContextProvider(() => ({
        appId: WIREFRAME_SURFACE_APP_ID,
        placePath: [WIREFRAME_ROOT_PLACE_ID],
        selection: { count: 0, ids: [], kinds: [], label: null },
        dirty: false,
      }));
    };
  }, [value.host]);

  return (
    <WireframeNavigationContext.Provider value={value}>
      {children}
    </WireframeNavigationContext.Provider>
  );
}

/** The provider's host + surface; throws when used outside the Wireframe shell. */
export function useWireframeNavigation(): WireframeNavigationValue {
  const value = useContext(WireframeNavigationContext);
  if (value === null) {
    throw new Error('useWireframeNavigation must be used inside WireframeNavigationProvider');
  }
  return value;
}

/* ───────────────────────────── place view ───────────────────────────── */

export interface WireframePlaceView {
  readonly placeId: string;
  readonly label: string;
  readonly cursor: string | null;
  readonly operator: string | null;
  readonly transient: boolean;
  readonly armed: 'rect' | 'ellipse' | null;
}

interface CachedPlaceView {
  readonly signature: string;
  readonly view: WireframePlaceView;
}

const placeViewCache = new WeakMap<NavigationHost, CachedPlaceView>();

function placeViewFor(host: NavigationHost): WireframePlaceView {
  const snapshot = host.getSnapshot();
  const path = snapshot.context.placePath;
  const placeId = path[path.length - 1] ?? WIREFRAME_ROOT_PLACE_ID;
  const place = wireframeSurface.tree.places.find((candidate) => candidate.id === placeId);
  const armed = getArmedWireframeShape();
  const cursor = place?.cursor ?? null;
  const operator = place?.operator ?? null;
  const transient = place?.transient === true;
  const signature = `${placeId}|${cursor ?? ''}|${operator ?? ''}|${transient}|${armed ?? ''}`;

  const cached = placeViewCache.get(host);
  if (cached !== undefined && cached.signature === signature) return cached.view;

  const view: WireframePlaceView = {
    placeId,
    label: place?.label ?? placeId,
    cursor,
    operator,
    transient,
    armed,
  };
  placeViewCache.set(host, { signature, view });
  return view;
}

/**
 * The cached place slice the canvas reads instead of the journal snapshot. The returned
 * reference is stable between semantically identical host notifications.
 */
export function useWireframePlaceView(host: NavigationHost): WireframePlaceView {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeHost = host.subscribe(listener);
      const unsubscribeArmed = subscribeArmedWireframeShape(listener);
      return () => {
        unsubscribeHost();
        unsubscribeArmed();
      };
    },
    [host],
  );
  return useSyncExternalStore(
    subscribe,
    () => placeViewFor(host),
    () => placeViewFor(host),
  );
}

/* ───────────────────────────── key adapter ───────────────────────────── */

/** Options the shell supplies to the ONE key adapter. */
export interface WireframeKeyAdapterOptions {
  /**
   * Observe the verb a stroke would dispatch (place bindings resolve to their place id,
   * aliases to their verb id). Return `true` to CONSUME the stroke without dispatch —
   * the shell uses this for the dirty New-document guard.
   */
  readonly beforeDispatch?: (verbId: string) => boolean;
}

/** The declared verb/place a stroke targets in the CURRENT place, or `null`. */
export function wireframeStrokeTarget(
  host: NavigationHost,
  token: string,
): string | null {
  const path = host.getSnapshot().context.placePath;
  const currentId = path[path.length - 1];
  const place = wireframeSurface.tree.places.find((candidate) => candidate.id === currentId);
  const binding = place?.keys[token];
  if (binding !== undefined) {
    return binding.kind === 'verb' ? binding.verbId : binding.placeId;
  }
  return wireframeSurface.tree.directAliases[token] ?? null;
}

/**
 * Normalise `event.key` to a declared stroke token. `?` is its own special token (the
 * adapter dispatches `app.map` DIRECTLY — never synthesised as `m`, because Create binds
 * `m` to `wireframe.add.image`); `/` is inert (launcher is P6).
 */
function tokenForEvent(event: ReactKeyboardEvent<HTMLElement>): string | null {
  const key = event.key;
  if (key === 'Escape') return 'Escape';
  if (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown'
  ) {
    return key;
  }
  if (key === '+' || key === '-' || key === '0') return key;
  if (key === '?') return '?';
  if (key === '/') return null; // inert — the launcher arrives in P6
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return lower;
  }
  return null;
}

/** Open the map once when an `app.map` dispatch performed (never for `m` in Create). */
function openMapAfter(result: DispatchResult | null, host: NavigationHost): void {
  if (result?.status === 'performed' && result.entry.verbId === 'app.map') {
    host.openMap(null);
  }
}

/**
 * The ONE element-scoped Wireframe key adapter.
 *
 * Attach it to the shell root's `onKeyDown` (bubbling). It never moves focus, never
 * installs a document listener, and never awaits anything before `host.handleStroke` —
 * the adapter-to-dispatch call is synchronous; only journal completion lands a microtask
 * later (the Q-10 invocation reading).
 */
export function handleWireframeKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  host: NavigationHost,
  nowMs: number,
  options: WireframeKeyAdapterOptions = {},
): void {
  // 1 — IME composition.
  if (event.nativeEvent.isComposing) return;
  // 2 — modifier chords never resolve a place stroke (Shift is allowed for `?`).
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // 3 — the map dialog owns its own keys.
  if (host.getSnapshot().mapOpen) return;

  const target = event.target instanceof Element ? event.target : null;
  // 4 — a modal dialog (belt; the map already returned above).
  if (target !== null && target.closest('[aria-modal="true"]') !== null) return;
  // 5 — typing in a field is never a stroke.
  if (isTextControl(target)) return;
  // 6 — a control already handled the key.
  if (event.defaultPrevented) return;

  // 7 — token map.
  const token = tokenForEvent(event);
  if (token === null) return;

  event.preventDefault();

  // `?` dispatches the declared `app.map` verb DIRECTLY, in every place.
  if (token === '?') {
    void host.runVerb('app.map', 'keyboard', {}).then((result) => {
      if (result.status === 'performed') host.openMap(null);
    });
    return;
  }

  // The shell's dirty guard may consume a stroke (e.g. File `n` on a dirty document).
  const verbId = wireframeStrokeTarget(host, token);
  if (verbId !== null && options.beforeDispatch?.(verbId) === true) return;

  // 8 — dispatch synchronously inside this keydown task.
  void host.handleStroke(token, nowMs).then((result) => openMapAfter(result, host));
}

/* ───────────────────────────── shell helper ───────────────────────────── */

/** Convenience for the shell: subscribe to the host snapshot (rail/map/trail only). */
export function useWireframeHostSnapshot(host: NavigationHost) {
  return useNavigationHostSnapshot(host);
}

/** Channel type re-export so the shell can type its verb runs. */
export type WireframeChannel = Channel;

/** A context snapshot with the FRESH store selection/dirty plus the host place path. */
export function useFreshWireframeContext(
  hostSnapshotContext: ContextSnapshot,
  storeContext: ContextSnapshot,
): ContextSnapshot {
  return useMemo(
    () => ({
      ...hostSnapshotContext,
      selection: storeContext.selection,
      dirty: storeContext.dirty,
    }),
    [hostSnapshotContext, storeContext],
  );
}
