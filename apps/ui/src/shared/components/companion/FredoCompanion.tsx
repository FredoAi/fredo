import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCompanion } from '../../contexts/CompanionContext';
import type { CompanionState } from '../../contexts/CompanionContext';
import { SpeechBubble } from './SpeechBubble';
import { TicTacToe } from './features/tictactoe';
import { AVATAR_SM, FredoAvatar } from '../fredo-avatar';
import './companion.css';
import { adapterBridge } from '../../utils/adapterBridge';
import type { LlmMessage } from '../../../app/adapters/HostAdapter';

// ── Animation timing (preserved from the sprite era — do NOT change) ────────
const ANIM_DURATION: Record<CompanionState, number> = {
  'idle':         800,
  'talk':          500,
  'teleport-out':  400,
  'teleport-in':   400,
};

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
const MY_WINDOW = new URLSearchParams(window.location.search).get('view') === 'terminal'
  ? 'terminal'
  : 'main';
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ── Component ────────────────────────────────────────────────────────────────

export const FredoCompanion: React.FC = () => {
  const { state, setState, teleport, showMessage, hideMessage, confirmAutoReturn, setHosting, notifyInteraction } = useCompanion();
  const { animState, message, isVisible, isAutoHidden, isAutoReturning, position } = state;

  const [displayPos, setDisplayPos] = useState({ x: position.x, y: position.y });
  const [streamingMessage, setStreamingMessage] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const isGeneratingRef = useRef(false);
  const [showTicTacToe, setShowTicTacToe] = useState(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // currentAnim drives which avatar state (expression) is shown
  const [currentAnim, setCurrentAnim] = useState<CompanionState>('idle');
  // animKey forces the wrapper to remount and restart the CSS animation cleanly
  const [animKey, setAnimKey] = useState(0);

  const isTeleportingRef = useRef(false);
  const pendingDestRef = useRef<{ x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-return settle timer (distinct from the teleport sequence timer):
  // observed from `isAutoReturning`, cleared on cancel/unmount.
  const autoReturnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Cross-window: companion starts in main, hidden in terminal
  const isInThisWindowRef = useRef(MY_WINDOW === 'main');
  const [isInThisWindow, setIsInThisWindow] = useState(MY_WINDOW === 'main');
  // Pending teleport-in destination — applied once the component becomes visible
  const pendingTeleportInRef = useRef<{ x: number; y: number } | null>(null);

  // #2853 ST-2: report host identity to the context so ONLY the webview that
  // currently displays the companion arms the host-owned idle auto-return timer.
  useEffect(() => { setHosting(isInThisWindow); }, [isInThisWindow, setHosting]);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  const playAnim = useCallback((anim: CompanionState) => {
    setCurrentAnim(anim);
    setAnimKey((k) => k + 1);
  }, []);

  // Sync context position changes (initial placement / external teleport)
  useEffect(() => {
    setDisplayPos({ x: position.x, y: position.y });
  }, [position.x, position.y]);

  // Respond to context animState (message show -> 'talk', hide -> 'idle')
  // Ignore during active teleport sequence
  useEffect(() => {
    if (isTeleportingRef.current) return;
    if (animState === 'talk' || animState === 'idle') {
      playAnim(animState);
    }
  }, [animState, playAnim]);

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

  // Once this window becomes active (cross-window arrival), fire the queued teleport-in
  useEffect(() => {
    if (isInThisWindow && pendingTeleportInRef.current) {
      const dest = pendingTeleportInRef.current;
      pendingTeleportInRef.current = null;
      isTeleportingRef.current = true;
      startTeleportIn(dest);
    }
  }, [isInThisWindow, startTeleportIn]);

  // Cross-window teleport via Tauri global events
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | null = null;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ toWindow: string; x: number; y: number }>('companion-teleport', (ev) => {
        const { toWindow, x, y } = ev.payload;

        if (toWindow === MY_WINDOW) {
          if (isInThisWindowRef.current) {
            // Same-window teleport: companion is already here, just move it
            startTeleportOut({ x, y });
          } else {
            // Cross-window arrival: make component visible, then teleport-in fires via effect
            isInThisWindowRef.current = true;
            pendingTeleportInRef.current = { x, y };
            setIsInThisWindow(true);
          }
        } else if (isInThisWindowRef.current) {
          // Companion is leaving this window — play teleport-out, THEN hide
          isInThisWindowRef.current = false;
          clearTimer();
          isTeleportingRef.current = true;
          playAnim('teleport-out');
          setState('teleport-out');
          timerRef.current = setTimeout(() => {
            // Hide only after animation finishes
            setIsInThisWindow(false);
            isTeleportingRef.current = false;
          }, ANIM_DURATION['teleport-out'] + 50);
        }
      }).then(fn => { unlisten = fn; });
    });

    return () => { unlisten?.(); };
  }, [playAnim, setState, startTeleportOut]);

  // ── Idle auto-return (host-initiated, distinct from teleport) ──────────────
  // The context requests the return when the host idle timer fires. Play the
  // existing teleport-out leave motion, then settle to hidden after the
  // preserved +50 ms gap and let the provider broadcast the global presence.
  // NOT startTeleportOut — that path re-enters via startTeleportIn.
  useEffect(() => {
    if (!isAutoReturning) return;
    playAnim('teleport-out');
    autoReturnTimerRef.current = setTimeout(() => {
      autoReturnTimerRef.current = null;
      confirmAutoReturn();
    }, ANIM_DURATION['teleport-out'] + 50);
    return () => {
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
    };
  }, [isAutoReturning, playAnim, confirmAutoReturn]);

  // Ctrl+right-click — teleport companion to THIS window at clicked position
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 2 || !e.ctrlKey) return;
    e.preventDefault();
    // #2853 ST-3: a teleport request is a companion interaction — reset the idle timer.
    notifyInteraction();
    // Clamp using the avatar's REAL rendered width AND height (never the old
    // 80x80 frame) so the full sm figure stays on-screen at every edge.
    const { width, height } = getAvatarSize();
    const targetX = Math.max(0, Math.min(e.clientX - width / 2, window.innerWidth - width));
    const targetY = Math.max(0, Math.min(e.clientY - height / 2, window.innerHeight - height));

    if (IS_TAURI) {
      // Broadcast to all webview windows (including this one)
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('companion-teleport', { toWindow: MY_WINDOW, x: targetX, y: targetY });
      });
    } else {
      // Dev mode: local-only teleport
      startTeleportOut({ x: targetX, y: targetY });
    }
  }, [startTeleportOut, getAvatarSize, notifyInteraction]);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    if (e.ctrlKey) e.preventDefault();
  }, []);

  useEffect(() => {
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('contextmenu', handleContextMenu);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [handleMouseDown, handleContextMenu]);

  useEffect(() => () => {
    clearTimer();
    if (autoReturnTimerRef.current) clearTimeout(autoReturnTimerRef.current);
  }, []);

  // ── LLM joke generation ───────────────────────────────────────────────────
  const askForJoke = useCallback(() => {
    console.log('[companion] askForJoke called — isTeleporting:', isTeleportingRef.current, 'isGenerating:', isGeneratingRef.current);
    if (isTeleportingRef.current || isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    setStreamingMessage('💭 Thinking...');
    setIsStreaming(true);
    playAnim('talk');
    setState('talk');

    console.log('[companion] calling adapterBridge.llmChat');
    adapterBridge.llmChat(
      buildJokeMessages(),
      (token) => {
        console.log('[companion] llm-token:', token.slice(0, 40));
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
        isGeneratingRef.current = false;
        setIsStreaming(false);
        // Hold 'talk' for 5 s then return to idle
        timerRef.current = setTimeout(() => {
          setStreamingMessage(null);
          playAnim('idle');
          setState('idle');
          hideMessage();
        }, 5000);
      },
    );
  }, [playAnim, setState, hideMessage]);

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

  // Hide when companion is not in this window, but keep mounted during teleport-out
  // so the leaving animation can still play. The auto-return gate keys on the
  // SETTLED `isAutoHidden` only, so the leave-motion frames stay mounted while
  // `isAutoReturning` is in flight (#2853 ST-2).
  if (!isVisible || isAutoHidden) return null;
  if (!isInThisWindow && !isTeleportingRef.current) return null;

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
              playAnim('talk');
              setState('talk');
            }}
            onDoneStreaming={() => {
              notifyInteraction();
              setIsStreaming(false);
              timerRef.current = setTimeout(() => {
                setStreamingMessage(null);
                playAnim('idle');
                setState('idle');
              }, 4000);
            }}
          />
        )}
      </SpeechBubble>

      {/* Interactive avatar wrapper — real click box is the avatar's layout
          width AND height (sm = 80 wide x 100 tall). The wrapper carries the
          state + streaming marks and the animKey remount that restarts the
          CSS motion keyframes (companion.css). Whole-element motion (idle bob,
          talk pulse, teleport shrink/fade + grow/settle) lives HERE on the
          wrapper — never inside the shared FredoAvatar. */}
      <div
        key={animKey}
        ref={wrapperRef}
        onClick={handleSpriteClick}
        data-state={currentAnim}
        data-streaming={isStreaming || undefined}
        title="Click to chat | Double-click to play Tic-Tac-Toe | Ctrl+right-click to teleport"
        aria-label={`Fredo companion -- ${currentAnim}`}
        className="fredo-companion-avatar"
        style={{
          position: 'fixed',
          left: displayPos.x,
          top: displayPos.y,
          width: AVATAR_SM.width,
          height: AVATAR_SM.height,
          zIndex: 100,
          pointerEvents: 'auto',
          cursor: isGeneratingRef.current ? 'default' : 'pointer',
        }}
      >
        <FredoAvatar size="sm" state={currentAnim} />
      </div>
    </>
  );
};
