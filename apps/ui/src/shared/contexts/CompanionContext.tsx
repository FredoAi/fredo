import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import { usePersistedSetting } from '../hooks/usePersistedSetting';

// ── Types ────────────────────────────────────────────────────────────────────

export type CompanionState = 'idle' | 'talk' | 'teleport-out' | 'teleport-in';

export interface CompanionPosition {
  x: number;
  y: number;
}

interface CompanionContextState {
  animState: CompanionState;
  message: string | null;
  messageDuration: number;
  isVisible: boolean;
  position: CompanionPosition;
  autoWalk: boolean;
  color: string;
}

type CompanionAction =
  | { type: 'SET_STATE'; payload: CompanionState }
  | { type: 'SHOW_MESSAGE'; payload: { text: string; duration: number } }
  | { type: 'HIDE_MESSAGE' }
  | { type: 'SET_VISIBLE'; payload: boolean }
  | { type: 'TELEPORT'; payload: CompanionPosition }
  | { type: 'TOGGLE_AUTO_WALK'; payload: boolean }
  | { type: 'SET_COLOR'; payload: string };

interface CompanionContextValue {
  state: CompanionContextState;
  setState: (s: CompanionState) => void;
  showMessage: (text: string, duration?: number) => void;
  hideMessage: () => void;
  setVisible: (visible: boolean) => void;
  teleport: (x: number, y: number) => void;
  toggleAutoWalk: (enabled: boolean) => void;
  setColor: (color: string) => void;
}

// ── Reducer ──────────────────────────────────────────────────────────────────

const DEFAULT_COLOR = '#a855f7'; // purple — matches Fredo accent

const initialState: CompanionContextState = {
  animState: 'idle',
  message: null,
  messageDuration: 4000,
  isVisible: false,
  position: { x: window.innerWidth - 120, y: window.innerHeight - 160 },
  autoWalk: true,
  color: DEFAULT_COLOR,
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
      return { ...state, isVisible: action.payload };
    case 'TELEPORT':
      return { ...state, position: action.payload };
    case 'TOGGLE_AUTO_WALK':
      return { ...state, autoWalk: action.payload };
    case 'SET_COLOR':
      return { ...state, color: action.payload };
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
  const [persistedColor, setPersistedColor] = usePersistedSetting<string>(
    'Fredo_companion_color', DEFAULT_COLOR,
  );
  const [persistedAutoWalk, setPersistedAutoWalk] = usePersistedSetting<boolean>(
    'Fredo_companion_auto_walk', true,
    (v) => String(v),
    (r) => r === 'true',
  );

  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    isVisible: persistedVisible,
    color: persistedColor,
    autoWalk: persistedAutoWalk,
  });

  // Sync persisted state back when the hook loads async values from SQLite
  useEffect(() => { dispatch({ type: 'SET_VISIBLE', payload: persistedVisible }); }, [persistedVisible]);
  useEffect(() => { dispatch({ type: 'SET_COLOR', payload: persistedColor }); }, [persistedColor]);
  useEffect(() => { dispatch({ type: 'TOGGLE_AUTO_WALK', payload: persistedAutoWalk }); }, [persistedAutoWalk]);

  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setState = useCallback((s: CompanionState) => {
    dispatch({ type: 'SET_STATE', payload: s });
  }, []);

  const showMessage = useCallback((text: string, duration = 4000) => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dispatch({ type: 'SHOW_MESSAGE', payload: { text, duration } });
    dismissTimerRef.current = setTimeout(() => {
      dispatch({ type: 'HIDE_MESSAGE' });
    }, duration);
  }, []);

  const hideMessage = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dispatch({ type: 'HIDE_MESSAGE' });
  }, []);

  const setVisible = useCallback((visible: boolean) => {
    dispatch({ type: 'SET_VISIBLE', payload: visible });
    setPersistedVisible(visible);
  }, [setPersistedVisible]);

  const teleport = useCallback((x: number, y: number) => {
    dispatch({ type: 'TELEPORT', payload: { x, y } });
  }, []);

  const toggleAutoWalk = useCallback((enabled: boolean) => {
    dispatch({ type: 'TOGGLE_AUTO_WALK', payload: enabled });
    setPersistedAutoWalk(enabled);
  }, [setPersistedAutoWalk]);

  const setColor = useCallback((color: string) => {
    dispatch({ type: 'SET_COLOR', payload: color });
    setPersistedColor(color);
  }, [setPersistedColor]);

  return (
    <CompanionContext.Provider value={{ state, setState, showMessage, hideMessage, setVisible, teleport, toggleAutoWalk, setColor }}>
      {children}
    </CompanionContext.Provider>
  );
};

export const useCompanion = (): CompanionContextValue => {
  const ctx = useContext(CompanionContext);
  if (!ctx) throw new Error('useCompanion must be used inside <CompanionProvider>');
  return ctx;
};
