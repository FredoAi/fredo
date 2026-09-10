import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { usePersistedSetting } from '../hooks/usePersistedSetting';

// ── Types ────────────────────────────────────────────────────────────────────

export type CompanionState = 'idle' | 'talk' | 'teleport-out' | 'teleport-in';

export interface CompanionPosition {
  x: number;
  y: number;
}

// ── Idle auto-return timeout (persisted setting, integer seconds) ─────────────
// #2853 ST-1: key sibling of `Fredo_companion_visible`; default 60 s, range
// [5, 3600]. `setVisible` remains the ONLY writer of the visibility key — the
// timeout is a separate persisted preference.

export const IDLE_TIMEOUT_SETTING_KEY = 'Fredo_companion_idle_timeout';
export const DEFAULT_IDLE_TIMEOUT_S = 60;
export const MIN_IDLE_TIMEOUT_S = 5;
export const MAX_IDLE_TIMEOUT_S = 3600;

/**
 * Resolve a (possibly corrupt) configured idle timeout to a usable value.
 * `!Number.isFinite(s) || s <= 0` → default; otherwise round then clamp to
 * [MIN_IDLE_TIMEOUT_S, MAX_IDLE_TIMEOUT_S]. A cleared / non-numeric / negative
 * value heals to the default on load instead of wedging the timer.
 */
export const clampIdleTimeout = (s: number): number => {
  if (!Number.isFinite(s) || s <= 0) return DEFAULT_IDLE_TIMEOUT_S;
  return Math.min(Math.max(Math.round(s), MIN_IDLE_TIMEOUT_S), MAX_IDLE_TIMEOUT_S);
};

// ── Cross-window presence coordination (#2853 ST-2) ──────────────────────────
// Each Tauri WebviewWindow loads this same bundle; distinguish them by ?view=.
// Mirrors the window identity + Tauri guard in FredoCompanion (the component is
// not imported here to avoid a context ↔ component cycle).
const MY_WINDOW = new URLSearchParams(window.location.search).get('view') === 'terminal'
  ? 'terminal'
  : 'main';
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Global broadcast payload — every window's CompanionProvider listens. */
interface CompanionPresencePayload {
  from: string;
  reason: 'idle-settle' | 'show' | 'hide';
  autoHidden?: boolean;
  visible?: boolean;
}

interface CompanionContextState {
  animState: CompanionState;
  message: string | null;
  messageDuration: number;
  isVisible: boolean;
  position: CompanionPosition;
  // Transient presence flags — NEVER persisted; `isAutoHidden` is cross-window
  // synced, `isAutoReturning`/`isHosting` are host-window-local.
  isAutoHidden: boolean;
  isAutoReturning: boolean;
  isHosting: boolean;
}

type CompanionAction =
  | { type: 'SET_STATE'; payload: CompanionState }
  | { type: 'SHOW_MESSAGE'; payload: { text: string; duration: number } }
  | { type: 'HIDE_MESSAGE' }
  | { type: 'SET_VISIBLE'; payload: boolean }
  | { type: 'TELEPORT'; payload: CompanionPosition }
  | { type: 'AUTO_RETURN_REQUESTED' }
  | { type: 'AUTO_RETURN_SETTLED' }
  | { type: 'CANCEL_AUTO_RETURN' }
  | { type: 'SET_HOSTING'; payload: boolean }
  | { type: 'SYNC_PRESENCE'; payload: { visible?: boolean; autoHidden?: boolean } };

interface CompanionContextValue {
  state: CompanionContextState;
  setState: (s: CompanionState) => void;
  showMessage: (text: string, duration?: number) => void;
  hideMessage: () => void;
  setVisible: (visible: boolean) => void;
  teleport: (x: number, y: number) => void;
  /** (Re)arm the host idle timer — any companion interaction; cancels an in-flight return. */
  notifyInteraction: () => void;
  idleTimeoutSeconds: number;
  setIdleTimeoutSeconds: (s: number) => void;
  /** Called by FredoCompanion on leave-motion settle; settles hidden + broadcasts. */
  confirmAutoReturn: () => void;
  /** FredoCompanion reports whether this webview currently displays the companion. */
  setHosting: (hosting: boolean) => void;
}

// ── Reducer ──────────────────────────────────────────────────────────────────

const initialState: CompanionContextState = {
  animState: 'idle',
  message: null,
  messageDuration: 4000,
  isVisible: false,
  position: { x: window.innerWidth - 120, y: window.innerHeight - 160 },
  isAutoHidden: false,
  isAutoReturning: false,
  isHosting: false,
};

function reducer(state: CompanionContextState, action: CompanionAction): CompanionContextState {
  switch (action.type) {
    case 'SET_STATE':
      return { ...state, animState: action.payload };
    case 'SHOW_MESSAGE':
      return { ...state, message: action.payload.text, messageDuration: action.payload.duration, animState: 'talk' };
    case 'HIDE_MESSAGE':
      return { ...state, message: null, animState: state.animState === 'talk' ? 'idle' : state.animState };
    case 'SET_VISIBLE':
      // Showing (or hiding by preference) clears any transient auto-return so the
      // companion is designated present again — without touching the persisted key.
      return { ...state, isVisible: action.payload, isAutoHidden: false, isAutoReturning: false };
    case 'TELEPORT':
      return { ...state, position: action.payload };
    case 'AUTO_RETURN_REQUESTED':
      return state.isAutoReturning ? state : { ...state, isAutoReturning: true };
    case 'AUTO_RETURN_SETTLED':
      return { ...state, isAutoHidden: true, isAutoReturning: false };
    case 'CANCEL_AUTO_RETURN':
      return state.isAutoReturning ? { ...state, isAutoReturning: false } : state;
    case 'SET_HOSTING':
      return state.isHosting === action.payload ? state : { ...state, isHosting: action.payload };
    case 'SYNC_PRESENCE': {
      // Remote presence: apply fields that were provided, always clear the local
      // in-flight return. Never persists (setVisible is the only persisted writer).
      const nextVisible = action.payload.visible === undefined ? state.isVisible : action.payload.visible;
      const nextAutoHidden = action.payload.autoHidden === undefined ? state.isAutoHidden : action.payload.autoHidden;
      if (nextVisible === state.isVisible && nextAutoHidden === state.isAutoHidden && !state.isAutoReturning) {
        return state; // idempotent — prevents a self-echo broadcast from looping
      }
      return { ...state, isVisible: nextVisible, isAutoHidden: nextAutoHidden, isAutoReturning: false };
    }
    default:
      return state;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

const CompanionContext = createContext<CompanionContextValue | null>(null);

export const CompanionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // ── Persisted settings loaded from SQLite (with localStorage fallback) ──
  const [persistedVisible, setPersistedVisible] = usePersistedSetting<boolean>(
    'Fredo_companion_visible', false,
    (v) => String(v),
    (r) => r === 'true',
  );

  const [idleTimeoutSeconds, setIdleTimeout] = usePersistedSetting<number>(
    IDLE_TIMEOUT_SETTING_KEY, DEFAULT_IDLE_TIMEOUT_S,
    (v) => String(v),
    (r) => clampIdleTimeout(Number(r)),
  );

  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    isVisible: persistedVisible,
  });

  // Sync persisted state back when the hook loads async values from SQLite
  useEffect(() => { dispatch({ type: 'SET_VISIBLE', payload: persistedVisible }); }, [persistedVisible]);

  // Latest state/timeout read from refs so the imperative timer helpers stay
  // referentially stable (never effect deps → no re-render loops, AGENTS.md #523).
  const stateRef = useRef(state);
  stateRef.current = state;
  const idleTimeoutRef = useRef(idleTimeoutSeconds);
  idleTimeoutRef.current = idleTimeoutSeconds;

  // Host-owned idle timer — one setTimeout handle in a ref, cleared before
  // re-arm and on unmount (mirrors dismissTimerRef). Never a setInterval.
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
  }, []);
  const armIdleTimer = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      dispatch({ type: 'AUTO_RETURN_REQUESTED' });
    }, idleTimeoutRef.current * 1000);
  }, [clearIdleTimer]);

  // #2853 ST-3: every companion interaction (re)arms the host idle timer and
  // recalls Fredo if he is mid auto-return. Host-local — only the host owns a
  // timer, so no cross-window reset broadcast is needed.
  const notifyInteraction = useCallback(() => {
    const s = stateRef.current;
    // No-op unless the companion is designated present in this (host) window.
    if (!s.isVisible || !s.isHosting || s.isAutoHidden) return;
    // An interaction during the leave motion recalls Fredo instead of hiding him.
    if (s.isAutoReturning) dispatch({ type: 'CANCEL_AUTO_RETURN' });
    armIdleTimer();
  }, [armIdleTimer]);

  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setState = useCallback((s: CompanionState) => {
    dispatch({ type: 'SET_STATE', payload: s });
  }, []);

  const showMessage = useCallback((text: string, duration = 4000) => {
    // #2853 ST-3: a shown message is a companion interaction — reset the idle timer.
    notifyInteraction();
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dispatch({ type: 'SHOW_MESSAGE', payload: { text, duration } });
    dismissTimerRef.current = setTimeout(() => {
      dispatch({ type: 'HIDE_MESSAGE' });
    }, duration);
  }, [notifyInteraction]);

  const hideMessage = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dispatch({ type: 'HIDE_MESSAGE' });
  }, []);

  // Broadcast transient presence to every webview (global Tauri event). Guarded
  // so dev/jsdom never attempts the dynamic import.
  const emitPresence = useCallback((payload: Omit<CompanionPresencePayload, 'from'>) => {
    if (!IS_TAURI) return;
    import('@tauri-apps/api/event').then(({ emit }) => {
      emit('companion-presence', { from: MY_WINDOW, ...payload });
    });
  }, []);

  const setVisible = useCallback((visible: boolean) => {
    // Apply locally FIRST, then broadcast — the host companion unmounts before
    // any other window's mascot mounts (never two Fredos).
    dispatch({ type: 'SET_VISIBLE', payload: visible });
    setPersistedVisible(visible);
    emitPresence({ reason: visible ? 'show' : 'hide', visible, autoHidden: false });
  }, [setPersistedVisible, emitPresence]);

  const teleport = useCallback((x: number, y: number) => {
    // #2853 ST-3: a teleport is a companion interaction — reset the idle timer.
    notifyInteraction();
    dispatch({ type: 'TELEPORT', payload: { x, y } });
  }, [notifyInteraction]);

  const confirmAutoReturn = useCallback(() => {
    // Settle locally FIRST, then broadcast the global presence.
    dispatch({ type: 'AUTO_RETURN_SETTLED' });
    emitPresence({ reason: 'idle-settle', autoHidden: true });
  }, [emitPresence]);

  const setHosting = useCallback((hosting: boolean) => {
    dispatch({ type: 'SET_HOSTING', payload: hosting });
  }, []);

  const setIdleTimeoutSeconds = useCallback((s: number) => {
    setIdleTimeout(clampIdleTimeout(s));
  }, [setIdleTimeout]);

  // Presence sync from other webviews — apply remote show/hide/settle WITHOUT
  // ever writing a persisted key (no echo/persist loop).
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<CompanionPresencePayload>('companion-presence', (ev) => {
        const { visible, autoHidden } = ev.payload;
        dispatch({ type: 'SYNC_PRESENCE', payload: { visible, autoHidden } });
      }).then((fn) => {
        if (cancelled) { fn(); return; }
        unlisten = fn;
      });
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Arm the idle timer ONLY while designated present in the hosting window.
  // Primitive deps only (no array .length / object identity) so this can never
  // loop; idleTimeoutSeconds is a dep so a mid-countdown change re-arms with it.
  useEffect(() => {
    const gate = state.isVisible && state.isHosting && !state.isAutoHidden && !state.isAutoReturning;
    if (!gate) { clearIdleTimer(); return; }
    armIdleTimer();
    return clearIdleTimer;
  }, [state.isVisible, state.isHosting, state.isAutoHidden, state.isAutoReturning, idleTimeoutSeconds, armIdleTimer, clearIdleTimer]);

  // Clear the idle timer on unmount.
  useEffect(() => () => clearIdleTimer(), [clearIdleTimer]);

  const value = useMemo<CompanionContextValue>(() => ({
    state, setState, showMessage, hideMessage, setVisible, teleport,
    notifyInteraction, idleTimeoutSeconds, setIdleTimeoutSeconds,
    confirmAutoReturn, setHosting,
  }), [
    state, setState, showMessage, hideMessage, setVisible, teleport,
    notifyInteraction, idleTimeoutSeconds, setIdleTimeoutSeconds,
    confirmAutoReturn, setHosting,
  ]);

  return (
    <CompanionContext.Provider value={value}>
      {children}
    </CompanionContext.Provider>
  );
};

export const useCompanion = (): CompanionContextValue => {
  const ctx = useContext(CompanionContext);
  if (!ctx) throw new Error('useCompanion must be used inside <CompanionProvider>');
  return ctx;
};
