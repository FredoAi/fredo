import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCompanion } from '../../contexts/CompanionContext';
import type { CompanionState } from '../../contexts/CompanionContext';
import { SpeechBubble } from './SpeechBubble';
import { TicTacToe } from './features/tictactoe';
import './companion.css';
import spritesheetUrl from '../../../assets/spritesheet.png';
import { adapterBridge } from '../../utils/adapterBridge';
import type { LlmMessage } from '../../../app/adapters/HostAdapter';

// ── Sprite-sheet constants ────────────────────────────────────────────────────
// Sheet: 1264x843px  |  6 cols x 4 rows  |  display at 80x80px per frame
const FRAME_W = 80;
const FRAME_H = 80;
const FRAMES_PER_ROW = 6;
const SHEET_DISPLAY_W = FRAME_W * FRAMES_PER_ROW; // 480
const SHEET_DISPLAY_H = FRAME_H * 4;               // 320

const ROW_Y: Record<CompanionState, number> = {
  'idle':          0,
  'talk':         -FRAME_H,
  'teleport-out': -FRAME_H * 2,
  'teleport-in':  -FRAME_H * 3,
};

const ANIM_DURATION: Record<CompanionState, number> = {
  'idle':         1200,
  'talk':          800,
  'teleport-out':  600,
  'teleport-in':   600,
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
  const { state, setState, teleport, showMessage, hideMessage } = useCompanion();
  const { animState, message, isVisible, position } = state;

  const [displayPos, setDisplayPos] = useState({ x: position.x, y: position.y });
  const [streamingMessage, setStreamingMessage] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const isGeneratingRef = useRef(false);
  const [showTicTacToe, setShowTicTacToe] = useState(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // currentAnim drives which row is displayed
  const [currentAnim, setCurrentAnim] = useState<CompanionState>('idle');
  // animKey forces the div to remount and restart CSS animation cleanly
  const [animKey, setAnimKey] = useState(0);

  const isTeleportingRef = useRef(false);
  const pendingDestRef = useRef<{ x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cross-window: companion starts in main, hidden in terminal
  const isInThisWindowRef = useRef(MY_WINDOW === 'main');
  const [isInThisWindow, setIsInThisWindow] = useState(MY_WINDOW === 'main');
  // Pending teleport-in destination — applied once the component becomes visible
  const pendingTeleportInRef = useRef<{ x: number; y: number } | null>(null);

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

  // Ctrl+right-click — teleport companion to THIS window at clicked position
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 2 || !e.ctrlKey) return;
    e.preventDefault();
    const targetX = Math.max(0, Math.min(e.clientX - FRAME_W / 2, window.innerWidth - FRAME_W));
    const targetY = Math.max(0, Math.min(e.clientY - FRAME_H / 2, window.innerHeight - FRAME_H));

    if (IS_TAURI) {
      // Broadcast to all webview windows (including this one)
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('companion-teleport', { toWindow: MY_WINDOW, x: targetX, y: targetY });
      });
    } else {
      // Dev mode: local-only teleport
      startTeleportOut({ x: targetX, y: targetY });
    }
  }, [startTeleportOut]);

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

  useEffect(() => () => clearTimer(), []);

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

  // ── Click / double-click on sprite ────────────────────────────────────────
  // Single click → ask for a joke; double-click → open/close TicTacToe in the bubble
  const handleSpriteClick = useCallback(() => {
    console.log('[companion] sprite clicked — showTicTacToe:', showTicTacToe, 'clickTimer:', !!clickTimerRef.current);
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
  }, [askForJoke, showTicTacToe]);

  // Hide when companion is not in this window, but keep mounted during teleport-out
  // so the leaving animation can still play
  if (!isVisible) return null;
  if (!isInThisWindow && !isTeleportingRef.current) return null;

  const isOneShot = currentAnim === 'teleport-out' || currentAnim === 'teleport-in';
  const duration = ANIM_DURATION[currentAnim];
  // One-shot: steps(5,end) over 0→-400px lands on frame 5, held by forwards fill-mode.
  // Loop: steps(6,end) over 0→-480px wraps cleanly back to frame 0.
  const animName = isOneShot ? 'Fredo-sprite-once' : 'Fredo-sprite-loop';
  const animSteps = isOneShot ? FRAMES_PER_ROW - 1 : FRAMES_PER_ROW;
  const animFill = isOneShot ? 'forwards' : 'none';

  // Prefer the live streaming message; fall back to context message.
  // Strip any model control tokens that may leak through (e.g. <end_of_turn>).
  const displayMessage = (streamingMessage ?? message)
    ?.replace(/<end_of_turn>|<start_of_turn>/g, '').trimEnd() || null;

  return (
    <>
      <SpeechBubble
        message={showTicTacToe ? null : displayMessage}
        companionX={displayPos.x}
        companionY={displayPos.y}
        companionWidth={FRAME_W}
        companionHeight={FRAME_H}
        isStreaming={isStreaming && !showTicTacToe}
      >
        {showTicTacToe && (
          <TicTacToe
            onStreamingMessage={(msg) => setStreamingMessage(msg)}
            onStartStreaming={() => {
              setIsStreaming(true);
              playAnim('talk');
              setState('talk');
            }}
            onDoneStreaming={() => {
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

      <div
        key={animKey}
        onClick={handleSpriteClick}
        title="Click to chat | Double-click to play Tic-Tac-Toe | Ctrl+right-click to teleport"
        aria-label={`Fredo companion -- ${currentAnim}`}
        style={{
          position: 'fixed',
          left: displayPos.x,
          top: displayPos.y,
          width: FRAME_W,
          height: FRAME_H,
          zIndex: 100,
          backgroundImage: `url(${spritesheetUrl})`,
          backgroundSize: `${SHEET_DISPLAY_W}px ${SHEET_DISPLAY_H}px`,
          backgroundPositionX: '0px',
          backgroundPositionY: `${ROW_Y[currentAnim]}px`,
          backgroundRepeat: 'no-repeat',
          animation: `${animName} ${duration}ms steps(${animSteps}, end) ${isOneShot ? `1 ${animFill}` : 'infinite'}`,
          imageRendering: 'pixelated',
          pointerEvents: 'auto',
          cursor: isGeneratingRef.current ? 'default' : 'pointer',
        }}
      />
    </>
  );
};
