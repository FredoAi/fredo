import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useCompanion } from '../../contexts/CompanionContext';
import type { CompanionPosition, CompanionState } from '../../contexts/CompanionContext';
import { SpeechBubble } from './SpeechBubble';
import { CompanionListeningBubble } from './CompanionListeningBubble';
import { TicTacToe } from './features/tictactoe';
import { AVATAR_SM, FredoAvatar } from '../fredo-avatar';
import type { FredoAvatarState } from '../fredo-avatar';
import { useFredoRestingCadence } from '../../hooks/useFredoRestingCadence';
import './companion.css';
import { adapterBridge } from '../../utils/adapterBridge';
import type { LlmMessage } from '../../../app/adapters/HostAdapter';
import { companionReplyErrorCopy } from './companionReadiness';

// ── Animation timing (preserved from the sprite era — do NOT change) ────────
export const ANIM_DURATION: Record<CompanionState, number> = {
  'idle':         800,
  'talk':          500,
  'teleport-out':  400,
  'teleport-in':   400,
};

// #2854 — status-flow hold durations. These are the EXISTING windows (the joke's
// 5 s hold and the TicTacToe onDone/outcome 4 s hold) — only the rendered
// expression changes, never the timing.
const HAPPY_HOLD_MS = 5000;
const TALK_HOLD_MS = 4000;
// #2871 ST-1r — how long the readable reply-error sentence stays in the bubble
// before the bubble clears (the error expression returns to idle immediately).
const ERROR_HOLD_MS = 8000;
// AC4 "no state sticks": any LLM-bound status (thinking/joking) that never
// receives its first token / completion falls back to idle after this bound.
const SAFETY_TIMEOUT_MS = 15000;

const JOKE_TOPICS = [
  'recursion', 'null pointers', 'git', 'CSS', 'regex', 'merge conflicts',
  'JavaScript', 'TypeScript', 'Rust', 'Python', 'compilers', 'debugging',
  'documentation', 'code reviews', 'off-by-one errors', 'binary',
  'async/await', 'memory leaks', 'Docker', 'databases',
];

// #2871 — the JOKE persona/system prompt. Used ONLY by the avatar-click joke
// path (`askForJoke`/`buildJokeMessages`); the launcher command bar's `ask`
// uses `FREDO_CHAT_PERSONA` below (a general assistant — no joke instruction).
export const FREDO_PERSONA =
  'You are Fredo, a friendly and enthusiastic little robot companion who loves programming. ' +
  'You have a playful personality and enjoy making developers smile. ' +
  'You love telling clever programming jokes and playing Tic-Tac-Toe. ' +
  'In Tic-Tac-Toe you always play as O against the human\'s X — the board has 9 cells numbered 0-8 ' +
  '(row 0: 0,1,2 | row 1: 3,4,5 | row 2: 6,7,8). ' +
  'To win you try to get three O\'s in a row; you also block X from completing a row of three. ' +
  'When asked to make a move you reply with only a single digit 0-8. ' +
  'For everything else, reply with a single short funny programming joke — no intro, no "sure!", just the joke itself.';

// #2871 ST-1r — the launcher command bar's chat persona. A general, concise
// desktop assistant: answer the user's message directly; do not default to a
// joke (the joke voice is `FREDO_PERSONA`, reserved for the avatar-click path).
export const FREDO_CHAT_PERSONA =
  'You are Fredo, a friendly, concise desktop assistant. ' +
  'Answer the user\'s message directly and helpfully in a warm but brief voice. ' +
  'Do not reply with a joke unless the user explicitly asks for one.';

function buildJokeMessages(): LlmMessage[] {
  const topic = JOKE_TOPICS[Math.floor(Math.random() * JOKE_TOPICS.length)];
  return [
    { role: 'system', content: FREDO_PERSONA },
    { role: 'user', content: `Tell me a short joke about ${topic}.` },
  ];
}

// ── Window identity ───────────────────────────────────────────────────────────
// Each Tauri WebviewWindow loads this same bundle. Distinguish them by ?view=.
// The interactive entity is the single owner of the window identity / Tauri
// guard: the overlay host (FredoCompanion) imports these for its window-level
// listener wiring so there is one source of truth.
export const MY_WINDOW = new URLSearchParams(window.location.search).get('view') === 'terminal'
  ? 'terminal'
  : 'main';
export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ── Active-entity registry (#2870 ST-2c) ─────────────────────────────────────
// Exactly ONE companion entity is mounted per window at a time: the home SEAT
// while Fredo is home, the away OVERLAY while he is away. The host
// (FredoCompanion) owns the single window-level listener set (Ctrl+right-click +
// companion-teleport); this module-scoped registry is how those listeners reach
// whichever surface is currently active — the seat and the overlay live in
// different React subtrees, so a surface-specific ref held by the host cannot
// see the seat. No listener is ever registered per surface.
let activeCompanionEntity: CompanionEntityHandle | null = null;

/** The companion entity currently mounted in THIS window, if any. */
export function getActiveCompanionEntity(): CompanionEntityHandle | null {
  return activeCompanionEntity;
}

function registerActiveCompanionEntity(handle: CompanionEntityHandle): () => void {
  activeCompanionEntity = handle;
  return () => {
    if (activeCompanionEntity === handle) activeCompanionEntity = null;
  };
}

/**
 * #2871 — dispatch a single-shot user message to THIS window's active companion
 * entity (the home seat at home, the away overlay while away — whichever is
 * mounted). The entity's `ask` streams the reply into its own SpeechBubble.
 *
 * Returns `true` iff this window has an active registered entity that accepted
 * the message; `false` when no companion is mounted in this window, which the
 * caller (the launcher command bar) treats as "companion inactive" and keeps
 * today's filter/launch behavior. This is the ONE dispatch path (G-149) — both
 * surfaces register the same handle into this registry; never add a second,
 * surface-specific route.
 */
export function askActiveCompanion(text: string): boolean {
  const entity = activeCompanionEntity;
  if (!entity) return false;
  entity.ask(text);
  return true;
}

/**
 * Clamp a Ctrl+right-click point so the FULL avatar box stays on-screen. Shared
 * by the entity (its measured rendered box) and the host's no-entity fallback
 * (the exact declared `AVATAR_SM` box) so the clamp math has ONE source.
 */
export function computeTeleportTarget(
  clientX: number,
  clientY: number,
  size: { width: number; height: number } = AVATAR_SM,
): CompanionPosition {
  const { width, height } = size;
  return {
    x: Math.max(0, Math.min(clientX - width / 2, window.innerWidth - width)),
    y: Math.max(0, Math.min(clientY - height / 2, window.innerHeight - height)),
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export interface CompanionEntityProps {
  /**
   * Which seat the entity is rendered at. `'overlay'` is the legacy window-level
   * floating companion (viewport-fixed wrapper + a `chooseSide` bubble);
   * `'seat'` renders in-flow inside its consumer's slot and anchors the bubble
   * absolutely above that slot (tail down, zero layout participation).
   */
  surface: 'seat' | 'overlay';
  /** Viewport position for `surface="overlay"` (ignored by `'seat'`). */
  x?: number;
  y?: number;
}

/**
 * Imperative surface the window host uses to drive the entity's teleport
 * choreography and to dispatch a Ctrl+right-click teleport request. The window
 * listeners themselves are registered once per window by the host (never per
 * surface); the host reaches whichever surface is currently mounted through the
 * module-scoped registry (`getActiveCompanionEntity`), which every entity
 * registers into — a surface-specific ref cannot see the seat.
 */
export interface CompanionEntityHandle {
  /** Which surface this handle belongs to (`'seat'` at home, `'overlay'` away). */
  surface: CompanionEntityProps['surface'];
  /** Ctrl+right-click request: clamp to the avatar box and dispatch to THIS window. */
  requestTeleport: (clientX: number, clientY: number) => void;
  /** Same-window teleport: play out → in at `dest`. */
  teleportTo: (dest: CompanionPosition) => void;
  /** Cross-window arrival: play the in motion at `dest`. */
  arrive: (dest: CompanionPosition) => void;
  /** Window leave: play the out motion, then invoke `onSettled` after the preserved +50 ms. */
  leaveWindow: (onSettled: () => void) => void;
  /** Auto-return leave motion (no re-entry, no context state change — the host owns the settle timer). */
  playLeave: () => void;
  /**
   * #2871 — single-shot user message: runs one fresh generation (shared persona
   * + this one user turn) and streams the reply into THIS entity's SpeechBubble.
   * A no-op while this entity already has a generation in flight (R-5.1).
   */
  ask: (text: string) => void;
}

export const CompanionEntity = forwardRef<CompanionEntityHandle, CompanionEntityProps>(
  ({ surface, x, y }, ref) => {
    const { state, setState, teleport, hideMessage, notifyInteraction, setInUse } = useCompanion();
    const { animState, message, isVisible, isAutoHidden, isHosting } = state;

    const [displayPos, setDisplayPos] = useState({ x: x ?? 0, y: y ?? 0 });
    const [streamingMessage, setStreamingMessage] = useState<string | null>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const isGeneratingRef = useRef(false);
    // #2871 R-5.1 — monotonic per-generation id. A start stamps this generation;
    // every token/done callback carries the id it was started with and is dropped
    // when that id is stale (a superseded generation), so a late callback can
    // never mutate the bubble of the current generation.
    const generationRef = useRef(0);
    // #2871 a11y (REQ-15 / DR-6) — the SINGLE polite live region for companion
    // replies. It holds a DISCRETE announcement (send / settled reply / error),
    // NEVER the streaming text, so tokens can never spam the AT. The bubble is
    // `aria-hidden` (decorative) so nothing double-announces.
    const [a11yAnnouncement, setA11yAnnouncement] = useState('');
    // Latest accumulated generation text (a ref, so capturing it costs no render).
    const generationTextRef = useRef('');
    // #2871 ST-1r (REQ-15) — the LIVE accumulated reply text, maintained
    // SYNCHRONOUSLY in `onToken` (never inside a React state updater). A state
    // updater runs at render/commit time, so the back-to-back `llm-error` →
    // `llm-done` path would read a stale/empty ref when it settles. `onToken`
    // computes `next` from this ref and assigns both refs before `setStreamingMessage`.
    const streamingTextRef = useRef('💭 Thinking...');
    // #2871 ST-1r — set true by the typed error path; `onDone` (the transport's
    // follow-up `finish()`) early-returns on it so an error can NEVER re-play the
    // success `happy` beat. Reset at the start of every generation.
    const generationErroredRef = useRef(false);
    // True while the CURRENT generation was started by the bar's `ask` path —
    // only that path announces (the avatar-click joke stays silent).
    const announceGenerationRef = useRef(false);
    const [showTicTacToe, setShowTicTacToe] = useState(false);
    const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // currentAnim drives which avatar state (expression) is shown. Widened from
    // `CompanionState` to the shared `FredoAvatarState` (#2854) so the companion's
    // LOCAL flow can hold thinking/joking/happy/playful WITHOUT touching the
    // presence reducer (`CompanionState` / `ANIM_DURATION` stay untouched).
    const [currentAnim, setCurrentAnim] = useState<FredoAvatarState>('idle');
    // animKey forces the wrapper to remount and restart the CSS animation cleanly
    const [animKey, setAnimKey] = useState(0);

    // #2854 — a status owned by the companion's local flow (thinking/joking/happy)
    // outranks the context `animState` sync. The flag is read inside effects/JSX
    // and never triggers a render, so it can not participate in a render loop.
    const flowOwnsExpressionRef = useRef(false);
    // #2854 AC4 — bounded fallback to idle for LLM-bound statuses (watchdog).
    const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // #2854 — the joke's first REAL token promotes thinking -> joking exactly once.
    const firstTokenRef = useRef(false);

    // #2854 — resting cadence: while truly at rest (no stream / game / message)
    // the companion emits a bounded `playful` beat, then returns to idle, repeating.
    const resting = useFredoRestingCadence(isStreaming || showTicTacToe || message != null);
    // The playful beat is a DERIVED display layer — it never mutates `currentAnim`,
    // so a flow-owned thinking/joking/happy always wins and playful only tints idle.
    const displayAnim: FredoAvatarState =
      currentAnim === 'idle' && resting === 'playful' ? 'playful' : currentAnim;

    const isTeleportingRef = useRef(false);
    const pendingDestRef = useRef<{ x: number; y: number } | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The interactive avatar wrapper — its live layout box (offsetWidth/offsetHeight,
    // immune to CSS transforms) is the runtime source of truth for the click-target,
    // the teleport clamp, and the SpeechBubble anchor. Falls back to AVATAR_SM before
    // the first layout (the declared sm size IS 80x100, so the fallback is exact).
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    const getAvatarSize = useCallback(() => {
      const el = wrapperRef.current;
      return {
        width: el ? el.offsetWidth : AVATAR_SM.width,
        height: el ? el.offsetHeight : AVATAR_SM.height,
      };
    }, []);

    // #2853 ST-3 (round 2): report CONTINUOUS use so the host idle gate suppresses
    // auto-return while Fredo is actively engaged — an open TicTacToe, an active
    // joke stream, or the talk hold. `isInUse` is intentionally NOT a dep (same
    // shape as setHosting) so the SET_IN_USE re-render cannot re-run this effect.
    useEffect(() => {
      setInUse(showTicTacToe || isStreaming || animState === 'talk');
    }, [showTicTacToe, isStreaming, animState, setInUse]);

    // Defensive: never leave the context stuck "in use" if this component unmounts
    // while the predicate is still true (component is mounted at app root).
    useEffect(() => () => setInUse(false), [setInUse]);

    const clearTimer = () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };

    const playAnim = useCallback((anim: FredoAvatarState) => {
      setCurrentAnim(anim);
      setAnimKey((k) => k + 1);
    }, []);

    // #2854 — a teleport OWNS the expression while in flight; a status flow must
    // never clobber the leaving/arriving motion (teleport timing + the
    // `isTeleportingRef` guard remain intact).
    const playFlowAnim = useCallback((anim: FredoAvatarState) => {
      if (isTeleportingRef.current) return;
      playAnim(anim);
    }, [playAnim]);

    // #2854 AC4 — every LLM-bound status carries a bounded watchdog. It clears on
    // the first token / done / error path / unmount (the same single-`setTimeout`
    // pattern as `timerRef`), so a dropped stream can never leave thinking/joking
    // stuck.
    const clearWatchdog = useCallback(() => {
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    }, []);

    const startWatchdog = useCallback(() => {
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        isGeneratingRef.current = false;
        setIsStreaming(false);
        setStreamingMessage(null);
        flowOwnsExpressionRef.current = false;
        playAnim('idle');
        setState('idle');
        hideMessage();
      }, SAFETY_TIMEOUT_MS);
    }, [clearWatchdog, playAnim, setState, hideMessage]);

    // Sync position changes from the host (initial placement / external teleport)
    useEffect(() => {
      setDisplayPos({ x: x ?? 0, y: y ?? 0 });
    }, [x, y]);

    // Respond to context animState (message show -> 'talk', hide -> 'idle').
    // Ignore during an active teleport sequence.
    //
    // #2854 sync guard: a flow-owned expression (thinking/joking/happy) must NOT be
    // clobbered by the context broadcast. `talk` is honored ONLY when a context
    // message is actually present (message-driven talk, e.g. Home's showMessage);
    // `idle` is honored only when no flow owns the expression and the resting
    // playful beat is not mid-flight (replaying idle would remount the wrapper and
    // cut the beat short).
    useEffect(() => {
      if (isTeleportingRef.current) return;
      if (animState === 'talk') {
        if (message != null) playAnim('talk');
        return;
      }
      if (animState === 'idle') {
        if (!flowOwnsExpressionRef.current && resting !== 'playful') {
          playAnim('idle');
        }
      }
    }, [animState, message, resting, playAnim]);

    // Teleport sequence (fully timer-driven)
    const startTeleportIn = useCallback((dest: { x: number; y: number }) => {
      teleport(dest.x, dest.y);
      setDisplayPos(dest);
      playAnim('teleport-in');

      timerRef.current = setTimeout(() => {
        isTeleportingRef.current = false;
        pendingDestRef.current = null;
        playAnim('idle');
        setState('idle');
      }, ANIM_DURATION['teleport-in'] + 50);
    }, [teleport, playAnim, setState]);

    const startTeleportOut = useCallback((dest: { x: number; y: number }) => {
      clearTimer();
      isTeleportingRef.current = true;
      pendingDestRef.current = dest;
      playAnim('teleport-out');
      setState('teleport-out');

      timerRef.current = setTimeout(() => {
        startTeleportIn(dest);
      }, ANIM_DURATION['teleport-out'] + 50);
    }, [playAnim, setState, startTeleportIn]);

    // Cross-window arrival: the host queued the destination once this window
    // became active — play the in motion here.
    const arrive = useCallback((dest: { x: number; y: number }) => {
      isTeleportingRef.current = true;
      startTeleportIn(dest);
    }, [startTeleportIn]);

    // Window leave: play the out motion, then let the host hide this window.
    const leaveWindow = useCallback((onSettled: () => void) => {
      clearTimer();
      isTeleportingRef.current = true;
      playAnim('teleport-out');
      setState('teleport-out');
      timerRef.current = setTimeout(() => {
        // Let the host hide the entity only after the animation finishes.
        isTeleportingRef.current = false;
        onSettled();
      }, ANIM_DURATION['teleport-out'] + 50);
    }, [playAnim, setState]);

    // Auto-return leave motion (the host owns the +50 ms settle timer and the
    // `confirmAutoReturn` broadcast; this only plays the leaving expression).
    const playLeave = useCallback(() => {
      playAnim('teleport-out');
    }, [playAnim]);

    // Ctrl+right-click — dispatch a teleport REQUEST for THIS window at the
    // clicked position. The host owns the window-level gesture listener; this is
    // the dispatch it invokes (the entity owns the avatar box used for clamping).
    const requestTeleport = useCallback((clientX: number, clientY: number) => {
      // #2853 ST-3: a teleport request is a companion interaction — reset the idle timer.
      notifyInteraction();
      // Clamp using the avatar's REAL rendered width AND height (never the old
      // 80x80 frame) so the full sm figure stays on-screen at every edge.
      const target = computeTeleportTarget(clientX, clientY, getAvatarSize());

      if (IS_TAURI) {
        // Broadcast to all webview windows (including this one)
        import('@tauri-apps/api/event').then(({ emit }) => {
          emit('companion-teleport', { toWindow: MY_WINDOW, x: target.x, y: target.y });
        });
      } else {
        // Dev mode: local-only teleport
        startTeleportOut(target);
      }
    }, [startTeleportOut, getAvatarSize, notifyInteraction]);

    // ── LLM generation core (joke + command-bar ask) ──────────────────────────
    // #2871 — ONE shared streaming lifecycle for every entry point: the
    // avatar-click joke and the launcher command bar's `ask(text)`. It owns the
    // single-in-flight guard, the stale-token counter, the thinking→joking
    // expression flow, the 15 s watchdog, and the happy-hold settle. Extracted
    // from the former `askForJoke` so the joke path is behavior-identical.
    const runGeneration = useCallback((messages: LlmMessage[]) => {
      console.log('[companion] runGeneration called — isTeleporting:', isTeleportingRef.current, 'isGenerating:', isGeneratingRef.current);
      if (isTeleportingRef.current || isGeneratingRef.current) return;
      isGeneratingRef.current = true;
      // #2871 R-5.1 — stamp THIS generation. Any token/done from an earlier
      // generation carries a stale id and is dropped by the guards below.
      const gen = ++generationRef.current;
      // #2871 a11y — reset the captured reply text and announce the send ONCE
      // (never per token) when this generation came from the bar's `ask` path.
      generationTextRef.current = '';
      streamingTextRef.current = '💭 Thinking...';
      generationErroredRef.current = false;
      if (announceGenerationRef.current) setA11yAnnouncement('Message sent to Fredo');
      firstTokenRef.current = false;
      setStreamingMessage('💭 Thinking...');
      setIsStreaming(true);
      // #2854 R-2a — the joke's LLM wait renders `thinking` (not `talk`). The
      // context state STAYS 'talk' as the presence/busy marker the #2853 `isInUse`
      // gate keys on (`animState === 'talk'`); the expression is flow-owned.
      flowOwnsExpressionRef.current = true;
      playFlowAnim('thinking');
      setState('talk');
      startWatchdog();

      console.log('[companion] calling adapterBridge.llmChat');
      adapterBridge.llmChat(
        messages,
        (token) => {
          // #2871 R-5.1 — a superseded generation's token must never be applied.
          if (gen !== generationRef.current) return;
          console.log('[companion] llm-token:', token.slice(0, 40));
          // #2854 R-2b — the first REAL token promotes the flow to `joking`; the
          // context state is intentionally untouched. (Empty/zero-token responses
          // skip `joking` — thinking -> happy -> idle.)
          if (!firstTokenRef.current && token.length > 0) {
            firstTokenRef.current = true;
            clearWatchdog();
            if (!isTeleportingRef.current) {
              playAnim('joking');
            }
          }
          // #2871 ST-1r (REQ-15) — accumulate SYNCHRONOUSLY off `streamingTextRef`,
          // never inside a `setStreamingMessage` updater. Both status placeholders
          // are replaced by the first real content token; the retry path emits
          // `⏳ Loading model...` through this same channel. Assigning the refs here
          // (before the state set) guarantees `onDone`/`onError` — which may run on
          // the same tick, e.g. `llm-error` → `finish()` — read a populated ref.
          const prev = streamingTextRef.current;
          const next = prev === '💭 Thinking...' || prev === '⏳ Loading model...'
            ? token
            : prev + token;
          streamingTextRef.current = next;
          generationTextRef.current = next;
          setStreamingMessage(next);
        },
        () => {
          // #2871 R-5.1 — a superseded generation's completion must not settle
          // the current one.
          if (gen !== generationRef.current) return;
          // #2871 ST-1r — the transport routes an `llm-error`/invoke rejection to
          // `onError` and THEN calls `finish()` → this callback. That follow-up
          // must not settle again: doing so would re-play the success `happy` beat
          // after the error path already returned to idle.
          if (generationErroredRef.current) return;
          console.log('[companion] llm-done received');
          isGeneratingRef.current = false;
          // #2871 a11y (REQ-15 / DR-6) — announce the SETTLED reply ONCE, never per
          // token. `generationTextRef` is populated synchronously by `onToken`, so
          // the settle always reads the full reply (no updater-timing gap).
          if (announceGenerationRef.current && generationTextRef.current) {
            setA11yAnnouncement(generationTextRef.current);
          }
          setIsStreaming(false);
          clearWatchdog();
          // #2871 ST-1r — clear the presence/busy marker UP-FRONT (the bar's
          // `isInUse` = talk || streaming) so the busy affordance clears on
          // completion rather than ~5 s later at the end of the happy hold. The
          // expression stays flow-owned, so the idle sync cannot clobber `happy`.
          setState('idle');
          // #2854 R-3a — completion renders `happy` through the EXISTING 5 s hold
          // (HAPPY_HOLD_MS; timing unchanged — only the expression changes), then
          // returns to idle. `flowOwns` is released on that return.
          flowOwnsExpressionRef.current = true;
          playFlowAnim('happy');
          timerRef.current = setTimeout(() => {
            flowOwnsExpressionRef.current = false;
            setStreamingMessage(null);
            playAnim('idle');
            setState('idle');
            hideMessage();
          }, HAPPY_HOLD_MS);
        },
        // #2871 ST-1r — the typed error channel (distinct from success). Map the
        // RAW backend/IPC detail to a readable sentence, return the expression to
        // idle PROMPTLY (never a `happy` beat), announce the readable sentence once
        // (bar path only), then hold it briefly before clearing.
        (raw) => {
          if (gen !== generationRef.current) return;
          const readable = companionReplyErrorCopy(raw);
          isGeneratingRef.current = false;
          generationErroredRef.current = true;
          clearWatchdog();
          setIsStreaming(false);
          // Both refs are assigned synchronously so the (follow-up) `onDone` and
          // any immediate read see the readable sentence, never the raw string.
          streamingTextRef.current = readable;
          generationTextRef.current = readable;
          setStreamingMessage(readable);
          if (announceGenerationRef.current) setA11yAnnouncement(readable);
          flowOwnsExpressionRef.current = false;
          playFlowAnim('idle');
          setState('idle');
          timerRef.current = setTimeout(() => {
            // A newer generation (a subsequent send) owns the bubble now — the
            // stale error hold must never clear it.
            if (gen !== generationRef.current) return;
            setStreamingMessage(null);
            hideMessage();
          }, ERROR_HOLD_MS);
        },
      );
    }, [playFlowAnim, playAnim, setState, hideMessage, clearWatchdog, startWatchdog]);

    // #2871 — avatar-click joke: shared persona + a random topic prompt. It does
    // NOT announce into the live region (only a bar send does).
    const askForJoke = useCallback(() => {
      announceGenerationRef.current = false;
      runGeneration(buildJokeMessages());
    }, [runGeneration]);

    // #2871 R-1.1 — the launcher command bar's single-shot message. Uses the
    // general assistant persona (`FREDO_CHAT_PERSONA` — no joke instruction), ONE
    // fresh user turn (no transcript/memory), streamed into THIS entity's
    // SpeechBubble. A no-op while a generation is already in flight (R-5.1).
    const ask = useCallback((text: string) => {
      // #2871 a11y — mark this generation as the bar-send path so it announces
      // "Message sent to Fredo" + the settled reply in the live region.
      announceGenerationRef.current = true;
      runGeneration([
        { role: 'system', content: FREDO_CHAT_PERSONA },
        { role: 'user', content: text },
      ]);
    }, [runGeneration]);

    const handle = useMemo<CompanionEntityHandle>(() => ({
      surface,
      requestTeleport,
      teleportTo: startTeleportOut,
      arrive,
      leaveWindow,
      playLeave,
      ask,
    }), [surface, requestTeleport, startTeleportOut, arrive, leaveWindow, playLeave, ask]);

    useImperativeHandle(ref, () => handle, [handle]);

    // Register this surface as THIS window's active entity so the host's
    // window-level listeners dispatch to it. Cleanup unregisters only if this
    // handle is still the active one (so a seat→overlay swap cannot be undone by
    // the departing surface's unmount).
    useEffect(() => registerActiveCompanionEntity(handle), [handle]);

    useEffect(() => () => {
      clearTimer();
      clearWatchdog();
    }, [clearWatchdog]);

    // ── Click / double-click on avatar ─────────────────────────────────────────
    // Single click → ask for a joke; double-click → open/close TicTacToe in the bubble
    const handleSpriteClick = useCallback(() => {
      // #2853 ST-3: a click/double-click is a companion interaction — reset the
      // idle timer (covers both the joke and the TicTacToe toggle).
      notifyInteraction();
      console.log('[companion] avatar clicked — showTicTacToe:', showTicTacToe, 'clickTimer:', !!clickTimerRef.current);
      if (clickTimerRef.current) {
        // Second click within 250 ms → double-click → toggle game
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
        console.log('[companion] double-click → toggle TicTacToe');
        setShowTicTacToe((v) => {
          if (!v) setStreamingMessage(null);
          return !v;
        });
        return;
      }
      // Start timer; if no second click arrives, treat as single click
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        console.log('[companion] single-click fired — showTicTacToe:', showTicTacToe);
        if (!showTicTacToe) askForJoke();
      }, 250);
    }, [askForJoke, showTicTacToe, notifyInteraction]);

    // ── Surface-scoped render gate (#2870 ST-2b) ──────────────────────────────
    // `overlay` is the AWAY overlay: it renders only in the window that hosts
    // Fredo, only while the role is ON (`isVisible`) and he is not auto-hidden.
    // `seat` is the home seat — its consumer (the launcher slice) owns when to
    // render it, so this surface is never gated by `isHosting`, `isAutoHidden`,
    // or away.
    if (surface === 'overlay') {
      if (!isVisible || isAutoHidden || !isHosting) return null;
    }

    // Prefer the live streaming message; fall back to context message.
    // Strip any model control tokens that may leak through (e.g. <end_of_turn>).
    const displayMessage = (streamingMessage ?? message)
      ?.replace(/<end_of_turn>|<start_of_turn>/g, '').trimEnd() || null;

    // Real rendered layout size for the bubble anchor + click box (offsetWidth/
    // offsetHeight — immune to the CSS transform animations on the wrapper).
    const { width: avatarWidth, height: avatarHeight } = getAvatarSize();

    return (
      <>
        {/* #2871 a11y (REQ-15 / DR-6): the bubble is DECORATIVE to assistive tech —
            its streamed text is announced through the single polite live region
            below, so the reply can never double-announce per token. The wrapper is
            static (the seat bubble still positions against the consumer's
            `position: relative` slot) and drops `aria-hidden` only while the
            interactive TicTacToe board is open so the game stays AT-reachable. */}
        <div aria-hidden={showTicTacToe ? undefined : 'true'}>
          <SpeechBubble
            positioning={surface === 'seat' ? 'absolute' : 'fixed'}
            message={showTicTacToe ? null : displayMessage}
            companionX={displayPos.x}
            companionY={displayPos.y}
            companionWidth={avatarWidth}
            companionHeight={avatarHeight}
            isStreaming={isStreaming && !showTicTacToe}
          >
            {showTicTacToe && (
              <TicTacToe
                onStreamingMessage={(msg) => {
                  // #2853 ST-3: game cells/streaming are companion interactions.
                  notifyInteraction();
                  setStreamingMessage(msg);
                }}
                onStartStreaming={() => {
                  notifyInteraction();
                  setIsStreaming(true);
                  // #2854 R-2c — the TicTacToe LLM wait renders `thinking`; `talk`
                  // stays the presence/busy marker (#2853 `isInUse`).
                  flowOwnsExpressionRef.current = true;
                  playFlowAnim('thinking');
                  setState('talk');
                  startWatchdog();
                }}
                onDoneStreaming={() => {
                  notifyInteraction();
                  setIsStreaming(false);
                  clearWatchdog();
                  // Preserved 4 s hold; the expression is whatever the flow set (a
                  // terminal outcome replaces this hold with `happy` via onOutcome).
                  timerRef.current = setTimeout(() => {
                    flowOwnsExpressionRef.current = false;
                    setStreamingMessage(null);
                    playAnim('idle');
                    setState('idle');
                  }, TALK_HOLD_MS);
                }}
                onOutcome={() => {
                  // #2854 R-3b — ANY terminal outcome (X win / O win / draw) renders
                  // `happy` for the existing 4 s window, then idle. A teleport owns
                  // the expression while in flight — never cancel its timer or
                  // clobber its motion with the outcome hold.
                  notifyInteraction();
                  if (isTeleportingRef.current) return;
                  // Clear the pending onDoneStreaming hold so the two never fight.
                  clearTimer();
                  clearWatchdog();
                  flowOwnsExpressionRef.current = true;
                  playFlowAnim('happy');
                  timerRef.current = setTimeout(() => {
                    flowOwnsExpressionRef.current = false;
                    setStreamingMessage(null);
                    playAnim('idle');
                    setState('idle');
                  }, TALK_HOLD_MS);
                }}
              />
            )}
          </SpeechBubble>
        </div>

        {/* #2871 a11y — the ONE `role="status" aria-live="polite"` region for the
            companion reply (visually hidden). It holds a DISCRETE announcement set
            on send and on completion/error, never the per-token stream, so it can
            announce ONCE per event and never spam. */}
        <div
          role="status"
          aria-live="polite"
          data-testid="fredo-companion-live-region"
          style={{
            position: 'absolute',
            width: '1px',
            height: '1px',
            padding: 0,
            margin: '-1px',
            overflow: 'hidden',
            clipPath: 'inset(50%)',
            whiteSpace: 'nowrap',
            borderWidth: 0,
          }}
        >
          {a11yAnnouncement}
        </div>

        {/* Interactive avatar wrapper — real click box is the avatar's layout
            width AND height (sm = 80 wide x 100 tall). The wrapper carries the
            state + streaming marks and the animKey remount that restarts the
            CSS motion keyframes (companion.css). Whole-element motion (idle bob,
            talk pulse, teleport shrink/fade + grow/settle) lives HERE on the
            wrapper — never inside the shared FredoAvatar. For the overlay the
            wrapper is viewport-fixed at the host-supplied (x, y); at the launcher
            seat it is in-flow inside the consumer's slot. */}
        <div
          key={animKey}
          ref={wrapperRef}
          onClick={handleSpriteClick}
          data-state={displayAnim}
          data-streaming={isStreaming || undefined}
          title="Click to chat | Double-click to play Tic-Tac-Toe | Ctrl+right-click to teleport"
          aria-label={`Fredo companion -- ${displayAnim}`}
          className="fredo-companion-avatar"
          style={{
            position: surface === 'seat' ? 'relative' : 'fixed',
            ...(surface === 'overlay' ? { left: displayPos.x, top: displayPos.y } : {}),
            width: AVATAR_SM.width,
            height: AVATAR_SM.height,
            zIndex: 100,
            pointerEvents: 'auto',
            cursor: isGeneratingRef.current ? 'default' : 'pointer',
          }}
        >
          <FredoAvatar size="sm" state={displayAnim} />
        </div>

        {/* #2877 ST-6 (DR-8) — the companion-origin listening affordance. Rendered
            OUTSIDE the decorative `aria-hidden` SpeechBubble wrapper so its Stop
            control stays AT-reachable. The bubble self-gates on
            `stt:state.origin === 'companion'` (R-5.3: exactly one indicator per
            session — the launcher bar cue owns `launcher`-origin), and this entity
            is the shared body for the home seat AND the away overlay, so a
            companion-origin capture is visible wherever Fredo is rendered (AC5). */}
        <CompanionListeningBubble
          surface={surface}
          x={displayPos.x}
          y={displayPos.y}
          anchorWidth={avatarWidth}
        />
      </>
    );
  },
);

CompanionEntity.displayName = 'CompanionEntity';
