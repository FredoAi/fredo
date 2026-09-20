import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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

// ── Voice input (persisted setting, opt-in) ──────────────────────────────────
// #2876 ST-5: `Fredo_companion_voice_enabled`, boolean, DEFAULT false
// (privacy-first opt-in). It is a sibling preference under Companion settings —
// `setVisible` remains the ONLY writer of the visibility key, and this flag
// NEVER gates companion chat.

export const VOICE_ENABLED_SETTING_KEY = 'Fredo_companion_voice_enabled';
export const DEFAULT_VOICE_ENABLED = false;

// ── Voice input preferences (#2877 ST-2) ─────────────────────────────────────
// Two sibling preferences under Companion settings, persisted through the SAME
// `usePersistedSetting` path as the enable switch. `voiceAutosend` is the SETTING
// only — its dispatch (transcript → chat/launcher send) is #2878. `deviceId` is a
// cpal device id (the device NAME string, `""` = system default) resolved by the
// backend on the next session (R-3.2). Neither gates companion chat.

export const VOICE_AUTOSEND_SETTING_KEY = 'Fredo_companion_voice_autosend';
export const DEFAULT_VOICE_AUTOSEND = false;

export const VOICE_DEVICE_ID_SETTING_KEY = 'Fredo_companion_voice_device_id';
export const DEFAULT_VOICE_DEVICE_ID = '';

// ── Speech handling (#2897 ST-1, persisted setting) ──────────────────────────
// `Fredo_companion_voice_handling`, a CLOSED two-member set. Spec #2914 ST-3
// (R-4) reduced voice input to the SINGLE model-audio mode: `DEFAULT_VOICE_HANDLING`
// is now `'model'` and every stored value that is not the exact `'model'` literal
// (`'local'`, absent, unknown, stale) heals to `'model'`. The backend no longer
// reads the key (the local engine is deleted), so a persisted `'local'` simply
// renders the model-audio controls — there is no dead or blocked voice state.
// The setting still NEVER gates companion chat.
//
// NOTE (ST-3 scope): `voiceHandling`/`setVoiceHandling`/`VOICE_HANDLING_SETTING_KEY`
// remain EXPORTED this round because the concurrent ST-5 launcher rework still
// consumes them (`LauncherShell.tsx`). With the default + parse healing to
// `'model'`, `setVoiceHandling('local')` is already a no-op. The symbols are
// removed once ST-5 lands (reported as an integration step).

export type VoiceHandling = 'local' | 'model';

export const VOICE_HANDLING_SETTING_KEY = 'Fredo_companion_voice_handling';
export const DEFAULT_VOICE_HANDLING: VoiceHandling = 'model';

/**
 * Parse a stored speech-handling mode. Spec #2914 ST-3 (R-4): there is exactly
 * ONE voice mode, so every value — `'local'`, absent, unknown or cleared — heals
 * to `'model'`. The single-mode contract can never leave the app without a
 * usable voice path.
 */
const parseVoiceHandling = (_raw: string): VoiceHandling => DEFAULT_VOICE_HANDLING;

// ── Send-during-reply disposition (#2892 ST-1, persisted setting) ────────────
// `Fredo_companion_send_during_reply`, `'queue' | 'interrupt'`, DEFAULT 'queue'.
// This module is the ONE owner of the key/constants; the entity + launcher
// consume the value (their slices). Any stored value that is not the literal
// `'interrupt'` heals to the default on load (closed two-member set).

export type CompanionSendDisposition = 'queue' | 'interrupt';

export const COMPANION_SEND_DURING_REPLY_KEY = 'Fredo_companion_send_during_reply';
export const DEFAULT_COMPANION_SEND_DURING_REPLY: CompanionSendDisposition = 'queue';

// ── Reply hold-open grace (#2892 ST-1, persisted setting, integer ms) ────────
// `Fredo_companion_reply_leave_grace_ms`, default 2000 ms, clamped to
// [0, 60000]. Consumed by `useReplyProtection` (ST-2); the settings UI (ST-6)
// displays seconds and persists integer ms through `clampReplyLeaveGraceMs`.

export const REPLY_LEAVE_GRACE_SETTING_KEY = 'Fredo_companion_reply_leave_grace_ms';
export const DEFAULT_REPLY_LEAVE_GRACE_MS = 2000;
export const MIN_REPLY_LEAVE_GRACE_MS = 0;
export const MAX_REPLY_LEAVE_GRACE_MS = 60000;
export const REPLY_LEAVE_GRACE_STEP_MS = 250;

/**
 * Resolve a (possibly corrupt) configured reply hold-open grace to a usable
 * integer ms value. Non-finite → default (2000); otherwise round then clamp to
 * [MIN_REPLY_LEAVE_GRACE_MS, MAX_REPLY_LEAVE_GRACE_MS]. A cleared / non-numeric
 * stored value heals to the default on load; an out-of-range value clamps.
 */
export const clampReplyLeaveGraceMs = (ms: number): number => {
  if (!Number.isFinite(ms)) return DEFAULT_REPLY_LEAVE_GRACE_MS;
  return Math.min(Math.max(Math.round(ms), MIN_REPLY_LEAVE_GRACE_MS), MAX_REPLY_LEAVE_GRACE_MS);
};

/**
 * Parse a stored send-during-reply disposition. Anything that is not the exact
 * `'interrupt'` literal (unknown/stale/cleared) heals to the default `'queue'`.
 */
const parseSendDuringReply = (raw: string): CompanionSendDisposition =>
  raw === 'interrupt' ? 'interrupt' : DEFAULT_COMPANION_SEND_DURING_REPLY;

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

// ── Welcome-on-turn-on (#2870 ST-1 / R-2) ─────────────────────────────────────
// Exact copy (deterministic — no random variant) shown through `showMessage`
// with an explicit 4000 ms duration on every OFF→ON turn-on. On-screen only;
// no audio / TTS anywhere.

export const WELCOME_TEXT = 'At your service. How can I help?';

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
  // #2870 ST-1: `teleport` added — emitted by the destination window when a
  // teleport lands, so every other window learns Fredo left the home seat.
  reason: 'idle-settle' | 'show' | 'hide' | 'teleport';
  autoHidden?: boolean;
  visible?: boolean;
  // #2870 ST-1: canonical home/away location — transient, never persisted.
  away?: boolean;
}

interface CompanionContextState {
  animState: CompanionState;
  message: string | null;
  messageDuration: number;
  isVisible: boolean;
  // #2870 ST-1: ONE canonical location for the single Fredo. `false` = he is at
  // the launcher's home seat; `true` = he has left it (teleported within a
  // window, or hosted/teleported in another window). Transient — NEVER
  // persisted; synced cross-window through `companion-presence {away}`.
  isAway: boolean;
  position: CompanionPosition;
  // Transient presence flags — NEVER persisted; `isAutoHidden` is cross-window
  // synced, `isAutoReturning`/`isHosting`/`isInUse` are host-window-local.
  isAutoHidden: boolean;
  isAutoReturning: boolean;
  isHosting: boolean;
  // #2853 ST-3 (round 2): continuous-interaction suppression — true while Fredo
  // is actively in use (open TicTacToe / active joke stream / talk hold). Host-
  // local and transient: never persisted, never broadcast.
  isInUse: boolean;
}

type CompanionAction =
  | { type: 'SET_STATE'; payload: CompanionState }
  | { type: 'SHOW_MESSAGE'; payload: { text: string; duration: number } }
  | { type: 'HIDE_MESSAGE' }
  | { type: 'SET_VISIBLE'; payload: boolean }
  | { type: 'TELEPORT'; payload: CompanionPosition }
  // #2870 ST-1: the leaving window marks Fredo away LOCALLY on a cross-window
  // leave, so it never transiently renders a second Fredo at the seat before the
  // destination's `companion-presence {away:true}` broadcast lands.
  | { type: 'MARK_AWAY' }
  | { type: 'AUTO_RETURN_REQUESTED' }
  | { type: 'AUTO_RETURN_SETTLED' }
  | { type: 'CANCEL_AUTO_RETURN' }
  | { type: 'SET_HOSTING'; payload: boolean }
  | { type: 'SET_IN_USE'; payload: boolean }
  | { type: 'SYNC_PRESENCE'; payload: { visible?: boolean; autoHidden?: boolean; away?: boolean } };

interface CompanionContextValue {
  state: CompanionContextState;
  setState: (s: CompanionState) => void;
  showMessage: (text: string, duration?: number) => void;
  hideMessage: () => void;
  setVisible: (visible: boolean) => void;
  teleport: (x: number, y: number) => void;
  /**
   * #2870 ST-1: mark Fredo away from the home seat in THIS window without a
   * broadcast — the leaving window calls it with the cross-window gesture so no
   * transient second Fredo renders before the destination's broadcast lands.
   * Within-window teleports get the same flag from `teleport(x, y)`.
   */
  markAway: () => void;
  /** (Re)arm the host idle timer — any companion interaction; cancels an in-flight return. */
  notifyInteraction: () => void;
  idleTimeoutSeconds: number;
  setIdleTimeoutSeconds: (s: number) => void;
  /**
   * #2876 ST-5: opt-in voice input. Persisted as `Fredo_companion_voice_enabled`
   * (DEFAULT false, privacy-first). Toggled only by the Companion settings control
   * and NEVER a precondition for companion chat.
   */
  voiceEnabled: boolean;
  setVoiceEnabled: (enabled: boolean) => void;
  /**
   * #2877 ST-2: persisted autosend choice — `Fredo_companion_voice_autosend`
   * (DEFAULT false). The SETTING lives here; honoring it (transcript dispatch) is
   * #2878, out of this slice. Never a companion-chat gate.
   */
  voiceAutosend: boolean;
  setVoiceAutosend: (enabled: boolean) => void;
  /**
   * #2877 ST-2: persisted input-device selection —
   * `Fredo_companion_voice_device_id` (DEFAULT '' = system default). A cpal
   * device id (name); the backend resolves it on the next capture session (R-3.2).
   */
  voiceDeviceId: string;
  setVoiceDeviceId: (deviceId: string) => void;
  /**
   * #2914 ST-3 (was #2897 REQ-1): the persisted speech-handling mode. There is
   * exactly ONE voice mode (model audio), so this value is always `'model'` —
   * `'local'`/absent/unknown stored values heal to `'model'`. Retained this
   * round only because the concurrent launcher rework still reads it.
   */
  voiceHandling: VoiceHandling;
  setVoiceHandling: (handling: VoiceHandling) => void;
  /**
   * #2892 ST-1 (REQ-9): persisted send-during-reply disposition
   * (`Fredo_companion_send_during_reply`, DEFAULT 'queue'). The SETTING lives
   * here; its consumption (accept / queue / interrupt) is the entity + launcher.
   */
  sendDuringReply: CompanionSendDisposition;
  setSendDuringReply: (d: CompanionSendDisposition) => void;
  /**
   * #2892 ST-1 (REQ-10): persisted reply hold-open grace, integer ms
   * (`Fredo_companion_reply_leave_grace_ms`, DEFAULT 2000, clamped [0, 60000]).
   * Feeds `useReplyProtection` (ST-2).
   */
  replyLeaveGraceMs: number;
  setReplyLeaveGraceMs: (ms: number) => void;
  /**
   * #2892 ST-1 (REQ-3): transient truth — a reply generation is genuinely in
   * flight. Written ONLY by the CompanionEntity (mirrors the `isInUse`
   * single-writer invariant) and cleared on unmount; it never includes the
   * read-hold `replyProtected` state. NEVER persisted.
   */
  replyInFlight: boolean;
  setReplyInFlight: (v: boolean) => void;
  /**
   * #2892 ST-1 (REQ-5): transient count of accepted sends awaiting dispatch
   * (0 = none). Written by the CompanionEntity; drives the launcher's waiting
   * indicator. NEVER persisted.
   */
  queuedSendCount: number;
  setQueuedSendCount: (n: number) => void;
  /** Called by FredoCompanion on leave-motion settle; settles hidden + broadcasts. */
  confirmAutoReturn: () => void;
  /** FredoCompanion reports whether this webview currently displays the companion. */
  setHosting: (hosting: boolean) => void;
  /** FredoCompanion reports continuous use (open game / active stream / talk). */
  setInUse: (inUse: boolean) => void;
}

// ── Reducer ──────────────────────────────────────────────────────────────────

const initialState: CompanionContextState = {
  animState: 'idle',
  message: null,
  messageDuration: 4000,
  isVisible: false,
  isAway: false,
  // #2870 ST-2b: there is NO bottom-right corner default. Fredo renders at the
  // home seat (its own flow position) until a teleport moves him; the away
  // overlay's real coordinates come ONLY from a teleport target / gesture.
  position: { x: 0, y: 0 },
  isAutoHidden: false,
  isAutoReturning: false,
  isHosting: false,
  isInUse: false,
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
      // #2870 ST-1: a role change also returns Fredo HOME (R-3 — OFF renders the
      // decorative mascot at the seat; ON renders the companion in place).
      return { ...state, isVisible: action.payload, isAway: false, isAutoHidden: false, isAutoReturning: false };
    case 'TELEPORT':
      // #2870 ST-1: the ONLY relocation mechanism — any teleport leaves the seat.
      // #2870 F-68: a relocation MUST clear any prior hide state so the relocated
      // Fredo is present at its new location. A stale `isAutoHidden` (left by a
      // prior idle auto-return) otherwise gates the away overlay off AND keeps the
      // host idle gate disarmed → zero Fredos, stuck until an OFF/ON toggle.
      return { ...state, position: action.payload, isAway: true, isAutoHidden: false, isAutoReturning: false };
    case 'MARK_AWAY':
      // #2870 ST-1: idempotent local away (cross-window leave).
      // #2870 F-68: clear any prior hide state on relocation too (idempotent when
      // already away AND already un-hidden — no state churn).
      return state.isAway && !state.isAutoHidden
        ? state
        : { ...state, isAway: true, isAutoHidden: false };
    case 'AUTO_RETURN_REQUESTED':
      return state.isAutoReturning ? state : { ...state, isAutoReturning: true };
    case 'AUTO_RETURN_SETTLED':
      // #2870 ST-1: the idle auto-return is a RETURN to the home seat (R-3/R-5).
      return { ...state, isAway: false, isAutoHidden: true, isAutoReturning: false };
    case 'CANCEL_AUTO_RETURN':
      return state.isAutoReturning ? { ...state, isAutoReturning: false } : state;
    case 'SET_HOSTING':
      return state.isHosting === action.payload ? state : { ...state, isHosting: action.payload };
    case 'SET_IN_USE':
      return state.isInUse === action.payload ? state : { ...state, isInUse: action.payload };
    case 'SYNC_PRESENCE': {
      // Remote presence: apply fields that were provided, always clear the local
      // in-flight return. Never persists (setVisible is the only persisted writer).
      const nextVisible = action.payload.visible === undefined ? state.isVisible : action.payload.visible;
      const nextAutoHidden = action.payload.autoHidden === undefined ? state.isAutoHidden : action.payload.autoHidden;
      // #2870 ST-1: the canonical home/away location is synced too (a remote
      // teleport marks Fredo away; a remote idle-settle/show brings him home).
      const nextAway = action.payload.away === undefined ? state.isAway : action.payload.away;
      if (
        nextVisible === state.isVisible
        && nextAutoHidden === state.isAutoHidden
        && nextAway === state.isAway
        && !state.isAutoReturning
      ) {
        return state; // idempotent — prevents a self-echo broadcast from looping
      }
      return {
        ...state,
        isVisible: nextVisible,
        isAway: nextAway,
        isAutoHidden: nextAutoHidden,
        isAutoReturning: false,
      };
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

  // #2876 ST-5 — opt-in voice input (DEFAULT false). Only the settings toggle
  // writes this key; it is never touched by the visibility/presence plumbing.
  const [voiceEnabled, setVoiceEnabled] = usePersistedSetting<boolean>(
    VOICE_ENABLED_SETTING_KEY, DEFAULT_VOICE_ENABLED,
    (v) => String(v),
    (r) => r === 'true',
  );

  // #2877 ST-2 — the autosend preference (SETTING only; dispatch is #2878) and
  // the selected input device ('' = system default). Same persistence path.
  const [voiceAutosend, setVoiceAutosend] = usePersistedSetting<boolean>(
    VOICE_AUTOSEND_SETTING_KEY, DEFAULT_VOICE_AUTOSEND,
    (v) => String(v),
    (r) => r === 'true',
  );

  const [voiceDeviceId, setVoiceDeviceId] = usePersistedSetting<string>(
    VOICE_DEVICE_ID_SETTING_KEY, DEFAULT_VOICE_DEVICE_ID,
    (v) => v,
    (r) => r,
  );

  // #2897 ST-1 / #2914 ST-3 (R-4) — persisted speech handling, now a single
  // mode ('model'). Same `usePersistedSetting` path; every stored value that is
  // not 'model' heals to 'model' via `parseVoiceHandling`.
  const [voiceHandling, setVoiceHandlingValue] = usePersistedSetting<VoiceHandling>(
    VOICE_HANDLING_SETTING_KEY, DEFAULT_VOICE_HANDLING,
    (v) => v,
    (r) => parseVoiceHandling(r),
  );

  // #2892 ST-1 (REQ-9) — persisted send-during-reply disposition. Same
  // `usePersistedSetting` path as the idle timeout; a stale/unknown stored
  // value heals to the 'queue' default via `parseSendDuringReply`.
  const [sendDuringReply, setSendDuringReplyValue] = usePersistedSetting<CompanionSendDisposition>(
    COMPANION_SEND_DURING_REPLY_KEY, DEFAULT_COMPANION_SEND_DURING_REPLY,
    (v) => v,
    (r) => parseSendDuringReply(r),
  );

  // #2892 ST-1 (REQ-10) — persisted reply hold-open grace (integer ms). Same
  // path; a non-numeric stored value heals to 2000, out-of-range clamps.
  const [replyLeaveGraceMs, setReplyLeaveGraceMsValue] = usePersistedSetting<number>(
    REPLY_LEAVE_GRACE_SETTING_KEY, DEFAULT_REPLY_LEAVE_GRACE_MS,
    (v) => String(v),
    (r) => clampReplyLeaveGraceMs(Number(r)),
  );

  // #2892 ST-1 (REQ-3/REQ-5) — the two transient signals. Plain state, NEVER
  // persisted: the CompanionEntity is their single writer (reply truth +
  // queued-send count) and they vanish with the provider, exactly like
  // `isInUse` above.
  const [replyInFlight, setReplyInFlight] = useState(false);
  const [queuedSendCount, setQueuedSendCount] = useState(0);

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
    // #2870 ST-1 (R-2): fire the welcome bubble on the OFF→ON transition only
    // (expressed as `visible && was not visible`). The persisted-load effect
    // dispatches SET_VISIBLE directly, so a restored preference never greets.
    const wasVisible = stateRef.current.isVisible;
    // Apply locally FIRST, then broadcast — the host companion unmounts before
    // any other window's mascot mounts (never two Fredos).
    dispatch({ type: 'SET_VISIBLE', payload: visible });
    setPersistedVisible(visible);
    emitPresence({ reason: visible ? 'show' : 'hide', visible, autoHidden: false, away: false });
    if (visible && !wasVisible) showMessage(WELCOME_TEXT, 4000);
  }, [setPersistedVisible, emitPresence, showMessage]);

  const teleport = useCallback((x: number, y: number) => {
    // #2853 ST-3: a teleport is a companion interaction — reset the idle timer.
    notifyInteraction();
    // #2870 ST-1: a teleport is the ONLY relocation mechanism — Fredo leaves the
    // home seat, so mark him away locally AND broadcast the new location.
    // #2870 F-68: the broadcast also carries `autoHidden:false` so remote windows
    // clear a stale hide flag instead of retaining it (which would hide the
    // relocated Fredo there too).
    dispatch({ type: 'TELEPORT', payload: { x, y } });
    emitPresence({ reason: 'teleport', away: true, autoHidden: false });
  }, [notifyInteraction, emitPresence]);

  const markAway = useCallback(() => {
    // #2870 ST-1: local-only away for the leaving window (no broadcast — the
    // destination's `teleport` broadcast is authoritative for other windows).
    dispatch({ type: 'MARK_AWAY' });
  }, []);

  const confirmAutoReturn = useCallback(() => {
    // Settle locally FIRST, then broadcast the global presence.
    dispatch({ type: 'AUTO_RETURN_SETTLED' });
    emitPresence({ reason: 'idle-settle', autoHidden: true, away: false });
  }, [emitPresence]);

  const setHosting = useCallback((hosting: boolean) => {
    dispatch({ type: 'SET_HOSTING', payload: hosting });
  }, []);

  const setInUse = useCallback((inUse: boolean) => {
    dispatch({ type: 'SET_IN_USE', payload: inUse });
  }, []);

  const setIdleTimeoutSeconds = useCallback((s: number) => {
    setIdleTimeout(clampIdleTimeout(s));
  }, [setIdleTimeout]);

  // #2892 ST-1 (REQ-9): persist the disposition; a non-disposition value at
  // runtime heals to the default (mirrors the load-time parse).
  const setSendDuringReply = useCallback((d: CompanionSendDisposition) => {
    setSendDuringReplyValue(d === 'interrupt' ? 'interrupt' : DEFAULT_COMPANION_SEND_DURING_REPLY);
  }, [setSendDuringReplyValue]);

  // #2914 ST-3 (R-4): persist the speech-handling mode. With the single-mode
  // default (`'model'`), any non-`'model'` runtime value heals to `'model'` —
  // `setVoiceHandling('local')` (a stale caller) is therefore a no-op.
  const setVoiceHandling = useCallback((handling: VoiceHandling) => {
    setVoiceHandlingValue(handling === 'model' ? 'model' : DEFAULT_VOICE_HANDLING);
  }, [setVoiceHandlingValue]);

  // #2892 ST-1 (REQ-10): persist the grace as a clamped integer ms.
  const setReplyLeaveGraceMs = useCallback((ms: number) => {
    setReplyLeaveGraceMsValue(clampReplyLeaveGraceMs(ms));
  }, [setReplyLeaveGraceMsValue]);

  // Presence sync from other webviews — apply remote show/hide/settle WITHOUT
  // ever writing a persisted key (no echo/persist loop).
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<CompanionPresencePayload>('companion-presence', (ev) => {
        const { visible, autoHidden, away } = ev.payload;
        dispatch({ type: 'SYNC_PRESENCE', payload: { visible, autoHidden, away } });
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
    const gate = state.isVisible && state.isHosting && !state.isAutoHidden && !state.isAutoReturning && !state.isInUse;
    if (!gate) { clearIdleTimer(); return; }
    armIdleTimer();
    return clearIdleTimer;
  }, [state.isVisible, state.isHosting, state.isAutoHidden, state.isAutoReturning, state.isInUse, idleTimeoutSeconds, armIdleTimer, clearIdleTimer]);

  // Clear the idle timer on unmount.
  useEffect(() => () => clearIdleTimer(), [clearIdleTimer]);

  const value = useMemo<CompanionContextValue>(() => ({
    state, setState, showMessage, hideMessage, setVisible, teleport, markAway,
    notifyInteraction, idleTimeoutSeconds, setIdleTimeoutSeconds,
    confirmAutoReturn, setHosting, setInUse, voiceEnabled, setVoiceEnabled,
    voiceAutosend, setVoiceAutosend, voiceDeviceId, setVoiceDeviceId,
    voiceHandling, setVoiceHandling,
    sendDuringReply, setSendDuringReply, replyLeaveGraceMs, setReplyLeaveGraceMs,
    replyInFlight, setReplyInFlight, queuedSendCount, setQueuedSendCount,
  }), [
    state, setState, showMessage, hideMessage, setVisible, teleport, markAway,
    notifyInteraction, idleTimeoutSeconds, setIdleTimeoutSeconds,
    confirmAutoReturn, setHosting, setInUse, voiceEnabled, setVoiceEnabled,
    voiceAutosend, setVoiceAutosend, voiceDeviceId, setVoiceDeviceId,
    voiceHandling, setVoiceHandling,
    sendDuringReply, setSendDuringReply, replyLeaveGraceMs, setReplyLeaveGraceMs,
    replyInFlight, setReplyInFlight, queuedSendCount, setQueuedSendCount,
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
