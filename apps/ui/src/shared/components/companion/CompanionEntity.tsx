import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useCompanion } from '../../contexts/CompanionContext';
import type { CompanionPosition, CompanionState } from '../../contexts/CompanionContext';
import { SpeechBubble } from './SpeechBubble';
import { TicTacToe } from './features/tictactoe';
import { AVATAR_SM, FredoAvatar } from '../fredo-avatar';
import type { FredoAvatarState } from '../fredo-avatar';
import { useFredoRestingCadence } from '../../hooks/useFredoRestingCadence';
import './companion.css';
import { adapterBridge } from '../../utils/adapterBridge';
import type { LlmMessage } from '../../../app/adapters/HostAdapter';

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
// AC4 "no state sticks": any LLM-bound status (thinking/joking) that never
// receives its first token / completion falls back to idle after this bound.
const SAFETY_TIMEOUT_MS = 15000;

const JOKE_TOPICS = [
  'recursion', 'null pointers', 'git', 'CSS', 'regex', 'merge conflicts',
  'JavaScript', 'TypeScript', 'Rust', 'Python', 'compilers', 'debugging',
  'documentation', 'code reviews', 'off-by-one errors', 'binary',
  'async/await', 'memory leaks', 'Docker', 'databases',
];

function buildJokeMessages(): LlmMessage[] {
  const topic = JOKE_TOPICS[Math.floor(Math.random() * JOKE_TOPICS.length)];
  return [
    {
      role: 'system',
      content:
        'You are Fredo, a friendly and enthusiastic little robot companion who loves programming. ' +
        'You have a playful personality and enjoy making developers smile. ' +
        'You love telling clever programming jokes and playing Tic-Tac-Toe. ' +
        'In Tic-Tac-Toe you always play as O against the human\'s X — the board has 9 cells numbered 0-8 ' +
        '(row 0: 0,1,2 | row 1: 3,4,5 | row 2: 6,7,8). ' +
        'To win you try to get three O\'s in a row; you also block X from completing a row of three. ' +
        'When asked to make a move you reply with only a single digit 0-8. ' +
        'For everything else, reply with a single short funny programming joke — no intro, no "sure!", just the joke itself.',
    },
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
}

export const CompanionEntity = forwardRef<CompanionEntityHandle, CompanionEntityProps>(
  ({ surface, x, y }, ref) => {
    const { state, setState, teleport, hideMessage, notifyInteraction, setInUse } = useCompanion();
    const { animState, message, isVisible, isAutoHidden, isHosting } = state;

    const [displayPos, setDisplayPos] = useState({ x: x ?? 0, y: y ?? 0 });
    const [streamingMessage, setStreamingMessage] = useState<string | null>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const isGeneratingRef = useRef(false);
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

    const handle = useMemo<CompanionEntityHandle>(() => ({
      surface,
      requestTeleport,
      teleportTo: startTeleportOut,
      arrive,
      leaveWindow,
      playLeave,
    }), [surface, requestTeleport, startTeleportOut, arrive, leaveWindow, playLeave]);

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

    // ── LLM joke generation ───────────────────────────────────────────────────
    const askForJoke = useCallback(() => {
      console.log('[companion] askForJoke called — isTeleporting:', isTeleportingRef.current, 'isGenerating:', isGeneratingRef.current);
      if (isTeleportingRef.current || isGeneratingRef.current) return;
      isGeneratingRef.current = true;
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
        buildJokeMessages(),
        (token) => {
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
          setStreamingMessage((prev) => {
            // Clear the placeholder on the first real token
            if (prev === '💭 Thinking...' || prev === '⏳ Loading model...') return token;
            return (prev ?? '') + token;
          });
        },
        () => {
          console.log('[companion] llm-done received');
          isGeneratingRef.current = false;
          setIsStreaming(false);
          clearWatchdog();
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
      );
    }, [playFlowAnim, playAnim, setState, hideMessage, clearWatchdog, startWatchdog]);

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
      </>
    );
  },
);

CompanionEntity.displayName = 'CompanionEntity';
