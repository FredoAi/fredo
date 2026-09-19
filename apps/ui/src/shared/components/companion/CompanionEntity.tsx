import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCompanion } from '../../contexts/CompanionContext';
import type { CompanionPosition, CompanionState } from '../../contexts/CompanionContext';
import { SpeechBubble } from './SpeechBubble';
import { completeAvatarRect } from './replySurfaceLayout';
import type { ReplyAvatarRect, ReplySurfaceBounds } from './replySurfaceLayout';
import { TicTacToe } from './features/tictactoe';
import { AVATAR_SM, FredoAvatar } from '../fredo-avatar';
import type { FredoAvatarState } from '../fredo-avatar';
import { useFredoRestingCadence } from '../../hooks/useFredoRestingCadence';
import './companion.css';
import { adapterBridge } from '../../utils/adapterBridge';
import type { LlmMessage, LlmSkillCall } from '../../../app/adapters/HostAdapter';
import { registerAppOpenReplyPusher } from './skillBridge';
import type { AppOpenReply } from './appOpenReply';
import { companionReplyErrorCopy } from './companionReadiness';
import {
  REPLY_PROTECTION_ANNOUNCEMENT,
  shouldAnnounceProtection,
  useReplyProtection,
} from './replyProtection';
import { createCompanionSendQueue, resolveSendOutcome } from './companionDispatch';
import type { CompanionSendQueue, CompanionSendResult } from './companionDispatch';

// #2883 ST-6 — the plan-declared ADDITIVE `SpeechBubble` props (`## API Contracts
// & Data Models`). Typed here so this workstream compiles before ST-4 attaches
// them to the bubble's card; the SAME handlers are bound on the entity-owned
// wrapper, so the reply's pointer/keyboard protection never depends on the bubble
// change landing.
type ReplySurfaceProtectionProps = {
  onSurfaceEnter?: () => void;
  onSurfaceLeave?: () => void;
  onSurfaceFocus?: () => void;
  onSurfaceBlur?: () => void;
};

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
 * #2892 ST-4 (REQ-8) — returns the typed acceptance result, replacing the old
 * boolean that lied while a generation was already in flight:
 *   `null`                          → no entity mounted in this window (keep text)
 *   `{ outcome: 'dispatched' }`     → accepted, generation started (clear bar)
 *   `{ outcome: 'queued', ... }`    → accepted, waiting FIFO (clear bar)
 *   `{ outcome: 'rejected' }`       → not accepted (keep text)
 * This is the ONE dispatch path (G-149) — both surfaces register the same handle
 * into this registry; never add a second, surface-specific route.
 */
export function askActiveCompanion(text: string): CompanionSendResult | null {
  const entity = activeCompanionEntity;
  if (!entity) return null;
  return entity.ask(text);
}

/**
 * #2897 ST-3 (REQ-5) — dispatch a captured model-audio clip to THIS window's
 * active companion entity through the SAME registry as {@link askActiveCompanion}
 * (never a second conversation route — G-149). The entity attaches the clip to a
 * fresh turn and streams the reply into its own SpeechBubble. No transcript text
 * is fabricated for the turn; the clip IS the turn's input.
 *
 * Returns the typed acceptance result, mirroring `askActiveCompanion`:
 *   `null`                       → no entity mounted in this window
 *   `{ outcome: 'dispatched' }`  → accepted, audio generation started
 *   `{ outcome: 'rejected' }`    → not accepted (a teleport owns the entity)
 */
export function askActiveCompanionWithAudio(clipBase64: string): CompanionSendResult | null {
  const entity = activeCompanionEntity;
  if (!entity) return null;
  return entity.askWithAudio(clipBase64);
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

// #2886 ST-2 — the footprint measurement is epsilon-compared so a sub-pixel
// reflow never writes state (the #523 loop guard; same value as the bubble's
// layout epsilon).
const AVATAR_RECT_EPSILON_PX = 0.5;

function nearAvatarRect(a: ReplyAvatarRect, b: ReplyAvatarRect): boolean {
  return (
    Math.abs(a.top - b.top) < AVATAR_RECT_EPSILON_PX &&
    Math.abs(a.left - b.left) < AVATAR_RECT_EPSILON_PX &&
    Math.abs(a.right - b.right) < AVATAR_RECT_EPSILON_PX &&
    Math.abs(a.bottom - b.bottom) < AVATAR_RECT_EPSILON_PX
  );
}

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
  /**
   * Spec #2883 ST-2 (host side) / ST-6 (forwarding) — the launcher-measured reply
   * band (viewport pixels: `safeTop` under the notch, `barrierTop` = the command
   * bar's box top, `boundsLeft`/`boundsRight` = the launcher column's clip box
   * inset by the margin). Passed only for `surface="seat"`; the entity forwards it
   * to `SpeechBubble`'s additive `growth` prop. `undefined` ⇒ no measurement yet ⇒
   * today's fixed rendering exactly (R-5.3).
   */
  replyBounds?: ReplySurfaceBounds;
  /**
   * #2886 round 2 (F3) — ADDITIVE, optional. Reports whether THIS entity is
   * currently displaying a message surface (the exact condition the surface exists
   * under: `displayMessage != null`), so the launcher can keep the app tiles
   * MOUNTED (and measurable) for the whole reply display instead of unmounting
   * them at the send instant. Deliberately NOT `isInUse` — that flag clears at
   * `llm-done` and gates the bar's send. Reports `false` on unmount.
   */
  onMessageVisibilityChange?: (visible: boolean) => void;
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
   * #2892 ST-4 (REQ-5/REQ-6/REQ-7/REQ-8) — returns the typed acceptance result;
   * while a generation is in flight the persisted disposition decides between
   * queueing (FIFO, auto-drained on settle) and a logical interrupt. Never void.
   */
  ask: (text: string) => CompanionSendResult;
  /**
   * #2897 ST-3 (REQ-5) — model-audio turn: `clipBase64` is the captured 16 kHz
   * mono WAV from `stt_take_audio_clip`. Streams the reply on the SAME channels
   * `ask` uses; NO transcript text is sent (the clip IS the turn's input). Because
   * the audio turn cannot join the TEXT FIFO, an in-flight generation is
   * superseded via the same logical-interrupt path (the clip is never dropped).
   * `rejected` only when a teleport owns the entity.
   */
  askWithAudio: (clipBase64: string) => CompanionSendResult;
}

export const CompanionEntity = forwardRef<CompanionEntityHandle, CompanionEntityProps>(
  ({ surface, x, y, replyBounds, onMessageVisibilityChange }, ref) => {
    const {
      state, setState, teleport, hideMessage, notifyInteraction, setInUse,
      sendDuringReply, replyLeaveGraceMs, setReplyInFlight, setQueuedSendCount,
    } = useCompanion();
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
    // #2893 ST-7 — the skill-aware generation bookkeeping:
    //  - `generationUsesSkillsRef` — this generation went through the skill-aware
    //    path, so it may receive a pushed deterministic reply.
    //  - `skillPendingRef` — the model selected a skill; the settle is DEFERRED
    //    until the pushed reply lands (or the watchdog fires — R-1.4).
    //  - `generationSettledRef` — exactly ONE settle per generation (a pushed reply
    //    and the follow-up `llm-done` must not both settle).
    const generationUsesSkillsRef = useRef(false);
    const skillPendingRef = useRef(false);
    const generationSettledRef = useRef(false);
    // True while the CURRENT generation was started by the bar's `ask` path —
    // only that path announces (the avatar-click joke stays silent).
    const announceGenerationRef = useRef(false);
    const [showTicTacToe, setShowTicTacToe] = useState(false);
    const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // #2892 ST-4 (REQ-5/REQ-6) — the ONE FIFO of accepted-but-undispatched bar
    // sends. Entity-scoped: created once, and dropped with the entity on unmount
    // (cross-seat durability is EXPLICITLY OUT OF SCOPE). `drainSendQueueRef` is
    // kept current each render so the settle callbacks can start the next queued
    // generation without a useCallback dependency cycle.
    const sendQueueRef = useRef<CompanionSendQueue | null>(null);
    if (sendQueueRef.current === null) sendQueueRef.current = createCompanionSendQueue();
    const drainSendQueueRef = useRef<() => void>(() => {});

    // #2883 ST-6 (AC4) — the ONE hide gate for the reply this entity owns
    // (`replyProtection.ts`). The happy hold, the error hold and the watchdog all
    // route their MESSAGE clear through `clearReplyOrDefer`, which synchronously
    // consults the protection ref: while the reply is being read the clear is
    // suspended, and the leave-grace re-arms it (never resumes it). `protected`
    // joins the EXISTING `isInUse` predicate below (R-4.4) — this entity stays the
    // only writer of `isInUse`.
    const {
      protected: replyProtected,
      enter: enterReplyProtection,
      leave: leaveReplyProtection,
      clearOrDefer: clearReplyOrDefer,
      reset: resetReplyProtection,
    } = useReplyProtection(replyLeaveGraceMs);
    // The entity-owned reply is ON SCREEN (this entity streamed it) — NOT the
    // context-owned welcome bubble and NOT the game card. Exactly this case gains
    // the region/AT exposure and the protection handlers; the welcome bubble and
    // the 208×268 game card keep today's handling byte-for-byte.
    const replyOnScreen = !showTicTacToe && streamingMessage != null;

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

    // ── #2886 ST-2 — the ONE avatar-footprint measurement ──────────────────────
    // The same node whose box already feeds `getAvatarSize()` (above) and
    // `computeTeleportTarget`: the `.fredo-companion-avatar` wrapper. Its
    // VIEWPORT **LAYOUT** box (no CSS transform) is the placement anchor the
    // message surface must clear — NOT the `fredo-companion-surface` wrapper
    // (which contains only the absolutely-positioned bubble, so it measures
    // height 0), and NOT the wrapper's TRANSFORMED rect: the wrapper carries the
    // avatar's own whole-element motion (`idle` bob, `happy` `translateY(-3px)
    // scale(1.03)`, `playful`/`joking` sweep, teleport shrink), so
    // `getBoundingClientRect()` there reports the ANIMATED crown and the surface
    // would track it. That was the round-1 defect: the facing edge moved 3.37 px
    // and the bound strip collapsed to 8.00 px (14 − the 6.0 px `happy` lift).
    //
    // Seat: the wrapper is `position: relative` in-flow inside the launcher's
    // `position: relative` 80×100 seat slot, so its layout box is recovered from
    // the offset chain — the `offsetParent`'s viewport box + its border
    // (`clientTop`/`clientLeft`) + `offsetTop`/`offsetLeft` − its scroll. The seat
    // slot IS the avatar's box, so the result is exactly the 80×100 footprint the
    // placement needs (and it is transform-immune — the same source `getAvatarSize`
    // already uses).
    // Away overlay: the wrapper is `position: fixed` at the entity's own inline
    // `left`/`top` (`offsetParent === null`), so the layout box is `displayPos` +
    // the declared size.
    //
    // rAF-coalesced and epsilon-compared (no state write when no number changed —
    // AGENTS.md #523), and a degenerate/hidden box is completed from the declared
    // AVATAR_SM (80×100), so a zero-height measurement can never collapse the
    // placement again.
    const [avatarRect, setAvatarRect] = useState<ReplyAvatarRect | null>(null);
    const avatarRectRef = useRef<ReplyAvatarRect | null>(null);
    const avatarFrameRef = useRef<number | null>(null);

    const measureAvatarRect = useCallback(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const width = el.offsetWidth || AVATAR_SM.width;
      const height = el.offsetHeight || AVATAR_SM.height;

      let raw: ReplyAvatarRect;
      if (surface === 'overlay') {
        const left = displayPos.x;
        const top = displayPos.y;
        raw = { top, left, right: left + width, bottom: top + height, width, height };
      } else {
        const parent = el.offsetParent as HTMLElement | null;
        // `display: none` — there is no box to report; keep the last known one.
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        const left = parentRect.left + parent.clientLeft + el.offsetLeft - parent.scrollLeft;
        const top = parentRect.top + parent.clientTop + el.offsetTop - parent.scrollTop;
        raw = { top, left, right: left + width, bottom: top + height, width, height };
      }

      const next = completeAvatarRect(raw, AVATAR_SM);
      if (!next) return;
      const prev = avatarRectRef.current;
      if (prev && nearAvatarRect(prev, next)) return;
      avatarRectRef.current = next;
      setAvatarRect(next);
    }, [surface, displayPos.x, displayPos.y]);

    const scheduleAvatarMeasure = useCallback(() => {
      if (avatarFrameRef.current !== null) return;
      const run = () => {
        avatarFrameRef.current = null;
        measureAvatarRect();
      };
      if (typeof requestAnimationFrame === 'function') {
        avatarFrameRef.current = requestAnimationFrame(run);
      } else {
        run();
      }
    }, [measureAvatarRect]);

    // Re-measure on every commit (the seat can scroll / the overlay teleports /
    // the window resizes) and on the two events that move the box without a
    // commit; rAF coalescing + the epsilon guard keep this out of the loop.
    useLayoutEffect(() => {
      scheduleAvatarMeasure();
    });
    useEffect(() => {
      window.addEventListener('resize', scheduleAvatarMeasure);
      window.addEventListener('scroll', scheduleAvatarMeasure, true);
      return () => {
        window.removeEventListener('resize', scheduleAvatarMeasure);
        window.removeEventListener('scroll', scheduleAvatarMeasure, true);
      };
    }, [scheduleAvatarMeasure]);
    useEffect(() => () => {
      if (avatarFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(avatarFrameRef.current);
      }
      avatarFrameRef.current = null;
    }, []);

    // #2853 ST-3 (round 2): report CONTINUOUS use so the host idle gate suppresses
    // auto-return while Fredo is actively engaged — an open TicTacToe, an active
    // joke stream, or the talk hold. `isInUse` is intentionally NOT a dep (same
    // shape as setHosting) so the SET_IN_USE re-render cannot re-run this effect.
    // #2883 ST-6 (R-4.4): a reply being READ joins the same predicate, so the
    // context's idle gate (`CompanionContext.tsx:442-447`) can never fire and let
    // the seat unmount mid-read. This effect remains the ONLY writer of `isInUse` —
    // the protection hook never calls `setInUse` (no second writer).
    useEffect(() => {
      setInUse(showTicTacToe || isStreaming || animState === 'talk' || replyProtected);
    }, [showTicTacToe, isStreaming, animState, setInUse, replyProtected]);

    // #2892 ST-4 (REQ-3) — mirror the reply-generation truth to the context.
    // `replyInFlight` tracks `isStreaming` EXACTLY: true from a generation's start
    // and false on EVERY terminal path (onDone / onError / the watchdog / a
    // pushed-skill settle), because each of those calls `setIsStreaming(false)`.
    // This entity is its ONLY writer (the `isInUse` single-writer invariant); the
    // read-hold `replyProtected` NEVER enters this flag — that stays in the
    // byte-identical `isInUse` predicate above (AC2/AC4).
    useEffect(() => {
      setReplyInFlight(isStreaming);
    }, [isStreaming, setReplyInFlight]);

    // Defensive: never leave the context stuck "in use" / "replying" / "queued"
    // if this component unmounts while any of those is still true (component is
    // mounted at app root). #2892 ST-4 — the FIFO is dropped with the entity;
    // cross-seat durability is EXPLICITLY OUT OF SCOPE, so `drainAll()` is called
    // here and its return (the accepted-but-undispatched sends) is intentionally
    // discarded rather than silently leaked.
    useEffect(() => () => {
      setInUse(false);
      setReplyInFlight(false);
      setQueuedSendCount(0);
      sendQueueRef.current?.drainAll();
    }, [setInUse, setReplyInFlight, setQueuedSendCount]);

    // #2883 ST-6 (UI/UX `Dismissal protection`) — ONE polite announcement on the
    // FIRST entry to protection per generation (the existing live region below).
    // Never per token, never on a re-entry inside the same generation.
    const announcedProtectionGenRef = useRef(-1);
    useEffect(() => {
      if (!replyProtected) return;
      if (!shouldAnnounceProtection(announcedProtectionGenRef.current, generationRef.current)) return;
      announcedProtectionGenRef.current = generationRef.current;
      setA11yAnnouncement(REPLY_PROTECTION_ANNOUNCEMENT);
    }, [replyProtected]);

    // The reply leaving the screen ends protection (it was cleared while the
    // pointer was still over it, the game opened, or a new turn replaced it) —
    // protection must never outlive its surface and leave `isInUse` stuck true.
    useEffect(() => {
      if (!replyOnScreen) resetReplyProtection();
    }, [replyOnScreen, resetReplyProtection]);

    const clearTimer = useCallback(() => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    }, []);

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
        // #2893 ST-7 (R-1.4) — the watchdog is the backstop for a skill-pending
        // generation whose pushed reply never arrives (bridge unmounted, resolver
        // threw): clear the pending/settled flags so the generation can never stay
        // stuck and a later stale push is dropped.
        generationSettledRef.current = true;
        skillPendingRef.current = false;
        setIsStreaming(false);
        flowOwnsExpressionRef.current = false;
        playAnim('idle');
        setState('idle');
        // #2883 ST-6 (R-4.1, the ONE hide gate) — a watchdog that comes due while
        // the reply is being read must NOT take the reply away. The expression and
        // the busy flag still settle; only the MESSAGE clear is deferred until
        // protection ends (then it runs on a fresh grace — R-4.2).
        clearReplyOrDefer(() => {
          setStreamingMessage(null);
          hideMessage();
        });
        // #2892 ST-4 (REQ-5) — a settle is a settle: if a bar send was accepted
        // while this generation was in flight, it dispatches now (exactly once),
        // even on the watchdog path (never a silent drop).
        drainSendQueueRef.current();
      }, SAFETY_TIMEOUT_MS);
    }, [clearWatchdog, playAnim, setState, hideMessage, clearReplyOrDefer]);

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
    const runGeneration = useCallback((messages: LlmMessage[], withSkills = false, audioBase64?: string) => {
      console.log('[companion] runGeneration called — isTeleporting:', isTeleportingRef.current, 'isGenerating:', isGeneratingRef.current, 'withSkills:', withSkills, 'withAudio:', audioBase64 !== undefined);
      if (isTeleportingRef.current || isGeneratingRef.current) return;
      // #2892 ST-4 — a NEW generation owns the bubble: release any pending hold
      // timer (happy/error) left by the previous generation so a stale 5 s clear
      // can never take this reply away (the declared defect fix's guard belt).
      clearTimer();
      isGeneratingRef.current = true;
      // #2883 ST-6 (UI/UX `Dismissal protection`) — a NEW generation owns the
      // bubble: protection does not carry over, and a clear stashed by the previous
      // generation is dropped (it must never wipe this one).
      resetReplyProtection();
      // #2871 R-5.1 — stamp THIS generation. Any token/done from an earlier
      // generation carries a stale id and is dropped by the guards below.
      const gen = ++generationRef.current;
      // #2871 a11y — reset the captured reply text and announce the send ONCE
      // (never per token) when this generation came from the bar's `ask` path.
      generationTextRef.current = '';
      streamingTextRef.current = '💭 Thinking...';
      generationErroredRef.current = false;
      // #2893 ST-7 — reset the skill bookkeeping for THIS generation.
      generationUsesSkillsRef.current = withSkills;
      skillPendingRef.current = false;
      generationSettledRef.current = false;
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

      // ── #2893 ST-7 — the shared per-generation callbacks ──────────────────
      const onToken = (token: string) => {
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
      };

      const onDone = () => {
          // #2871 R-5.1 — a superseded generation's completion must not settle
          // the current one.
          if (gen !== generationRef.current) return;
          // #2871 ST-1r — the transport routes an `llm-error`/invoke rejection to
          // `onError` and THEN calls `finish()` → this callback. That follow-up
          // must not settle again: doing so would re-play the success `happy` beat
          // after the error path already returned to idle.
          if (generationErroredRef.current) return;
          // #2893 ST-7 — a pushed skill reply already settled this generation, and
          // a skill-pending generation defers its settle until the push lands (the
          // watchdog is the backstop). Raw tool-call JSON was never a token, so
          // there is nothing to show here.
          if (generationSettledRef.current) return;
          if (skillPendingRef.current) return;
          generationSettledRef.current = true;
          skillPendingRef.current = false;
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
            // #2892 ST-4 declared defect fix (REQ-7) — the same generation guard
            // the error hold below already has: a superseded generation's 5 s
            // timer must NEVER clear the NEW reply (interrupt / queue drain).
            if (gen !== generationRef.current) return;
            flowOwnsExpressionRef.current = false;
            playAnim('idle');
            setState('idle');
            // #2883 ST-6 (R-4.1, the ONE hide gate) — the shipped 5 s happy hold is
            // unchanged in VALUE; a reply being read when it comes due is kept, and
            // the clear runs when protection ends (fresh grace — R-4.2).
            clearReplyOrDefer(() => {
              setStreamingMessage(null);
              hideMessage();
            });
          }, HAPPY_HOLD_MS);
          // #2892 ST-4 (REQ-5) — this generation settled; dispatch the oldest
          // accepted send now (FIFO, exactly once). A queued dispatch supersedes
          // this settle visually and releases the timer just armed above.
          drainSendQueueRef.current();
      };

      // #2871 ST-1r — the typed error channel (distinct from success). Map the
      // RAW backend/IPC detail to a readable sentence, return the expression to
      // idle PROMPTLY (never a `happy` beat), announce the readable sentence once
      // (bar path only), then hold it briefly before clearing.
      const onError = (raw: string) => {
          if (gen !== generationRef.current) return;
          if (generationSettledRef.current) return;
          generationSettledRef.current = true;
          skillPendingRef.current = false;
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
            // #2883 ST-6 (R-4.1, the ONE hide gate) — the shipped 8 s error hold is
            // unchanged in VALUE; a reply being read when it comes due is kept, and
            // the clear runs when protection ends (fresh grace — R-4.2).
            clearReplyOrDefer(() => {
              setStreamingMessage(null);
              hideMessage();
            });
          }, ERROR_HOLD_MS);
          // #2892 ST-4 (REQ-5) — an error settle also drains: a send accepted
          // during a failed generation must not be stranded.
          drainSendQueueRef.current();
      };

      // #2893 ST-7 — a VALIDATED skill selection (backend already validated it
      // against the registry). Mark the generation skill-pending: its settle now
      // waits for the deterministic pushed reply (or the watchdog). Raw tool-call
      // JSON is NEVER rendered — the thinking placeholder stays until the push.
      const onSkillCall = (_call: LlmSkillCall) => {
          if (gen !== generationRef.current) return;
          if (generationSettledRef.current) return;
          skillPendingRef.current = true;
          // #2893 ST-9 (R-1.4) — the watchdog backstop MUST be armed while this
          // generation waits for the pushed deterministic reply. A content /
          // reasoning token that preceded the tool call already cleared the
          // first-token watchdog (`onToken`), so re-arm the SAME shipped timer
          // here (no new timer, no value change); when it is still armed the
          // existing bound is left untouched. Without this, a skill-pending
          // generation that streamed ANY token before the selection could wait
          // forever for a reply that never arrives (bridge unmounted / a
          // throwing pusher) — the stuck-state the invariant forbids.
          if (watchdogRef.current === null) startWatchdog();
      };

      if (audioBase64 !== undefined) {
        // #2897 ST-3 (REQ-5) — the clip IS the turn's input: the last user
        // message's content is replaced by the backend renderer with the single
        // `input_audio` part. No transcript text is sent for this turn.
        console.log('[companion] calling adapterBridge.llmChatWithAudio');
        adapterBridge.llmChatWithAudio(messages, audioBase64, onToken, onDone, onError);
      } else if (withSkills) {
        console.log('[companion] calling adapterBridge.llmChatWithSkills');
        adapterBridge.llmChatWithSkills(messages, onToken, onDone, onSkillCall, onError);
      } else {
        console.log('[companion] calling adapterBridge.llmChat');
        adapterBridge.llmChat(messages, onToken, onDone, onError);
      }
    }, [playFlowAnim, playAnim, setState, hideMessage, clearWatchdog, startWatchdog, resetReplyProtection, clearTimer]);

    // #2892 ST-4 (REQ-5/REQ-6) — dequeue-then-dispatch, exactly once. Whatever
    // generation just settled, if a send is waiting it becomes the current
    // generation here (the FIFO is entity-scoped and synchronous). Kept in a ref
    // so the settle callbacks inside `runGeneration` need no dependency edge back
    // to this callback (no cycle).
    drainSendQueueRef.current = () => {
      const queue = sendQueueRef.current;
      if (!queue) return;
      const next = queue.dequeue();
      if (!next) { setQueuedSendCount(0); return; }
      setQueuedSendCount(queue.size());
      announceGenerationRef.current = true;
      runGeneration([
        { role: 'system', content: FREDO_CHAT_PERSONA },
        { role: 'user', content: next.text },
      ], true);
    };

    // #2893 ST-7 — apply the deterministic app-open reply pushed by ST-6's
    // `useAppOpenRequests` hook to the SAME reply channel a streamed reply uses
    // (`streamingMessage` / `streamingTextRef` / the one polite live region). The
    // success kind settles with the shipped `happy` beat; every non-success kind
    // settles `idle` with the shipped `ERROR_HOLD_MS` hold — never a celebration.
    // Ref-guarded so a stale push (a settled/non-skill generation) is dropped.
    const applyAppOpenReply = useCallback((reply: AppOpenReply) => {
      if (!generationUsesSkillsRef.current) return;
      if (!isGeneratingRef.current || generationSettledRef.current) return;
      const gen = generationRef.current;
      generationSettledRef.current = true;
      skillPendingRef.current = false;
      isGeneratingRef.current = false;
      clearWatchdog();
      setIsStreaming(false);
      // Both refs assigned synchronously (same contract as the stream path).
      streamingTextRef.current = reply.text;
      generationTextRef.current = reply.text;
      setStreamingMessage(reply.text);
      if (announceGenerationRef.current) setA11yAnnouncement(reply.text);
      setState('idle');
      if (reply.kind === 'success') {
        flowOwnsExpressionRef.current = true;
        playFlowAnim('happy');
        timerRef.current = setTimeout(() => {
          if (gen !== generationRef.current) return;
          flowOwnsExpressionRef.current = false;
          playAnim('idle');
          setState('idle');
          clearReplyOrDefer(() => {
            setStreamingMessage(null);
            hideMessage();
          });
        }, HAPPY_HOLD_MS);
      } else {
        flowOwnsExpressionRef.current = false;
        playFlowAnim('idle');
        timerRef.current = setTimeout(() => {
          if (gen !== generationRef.current) return;
          clearReplyOrDefer(() => {
            setStreamingMessage(null);
            hideMessage();
          });
        }, ERROR_HOLD_MS);
      }
      // #2892 ST-4 (REQ-5) — the pushed-skill settle is a terminal path too:
      // drain any send accepted while this generation was in flight.
      drainSendQueueRef.current();
    }, [clearWatchdog, playFlowAnim, playAnim, setState, hideMessage, clearReplyOrDefer]);

    // Register this entity as the active reply receiver (mirrors the
    // `askActiveCompanion` registry above; exactly ONE entity per window is active
    // at a time). The bridge no-ops safely when nothing is mounted.
    useEffect(() => registerAppOpenReplyPusher(applyAppOpenReply), [applyAppOpenReply]);

    // #2871 — avatar-click joke: shared persona + a random topic prompt. It does
    // NOT announce into the live region (only a bar send does).
    const askForJoke = useCallback(() => {
      announceGenerationRef.current = false;
      runGeneration(buildJokeMessages());
    }, [runGeneration]);

    // #2871 R-1.1 — the launcher command bar's single-shot message. Uses the
    // general assistant persona (`FREDO_CHAT_PERSONA` — no joke instruction), ONE
    // fresh user turn (no transcript/memory), streamed into THIS entity's
    // SpeechBubble. #2892 ST-4 — it NO LONGER silently no-ops while a generation
    // is in flight: the persisted disposition decides between queueing the send
    // (FIFO, auto-drained on settle) and a logical interrupt, and the return value
    // tells the caller exactly what was accepted (REQ-5/REQ-6/REQ-7/REQ-8).
    // #2893 ST-7 — this path is SKILL-AWARE (`llmChatWithSkills`): a validated
    // `open_app` selection is marked skill-pending and its settle is deferred until
    // the pushed deterministic reply lands (or the watchdog fires). The joke path
    // above stays on the unchanged `llmChat`.
    const ask = useCallback((text: string): CompanionSendResult => {
      // #2871 a11y — mark this generation as the bar-send path so it announces
      // "Message sent to Fredo" + the settled reply in the live region.
      announceGenerationRef.current = true;
      // #2892 ST-4 (REQ-8) — a teleport owns the entity: there is no generation
      // and no settle to drain after, so the send is NOT accepted (the bar keeps
      // the text) rather than silently dropped.
      if (isTeleportingRef.current) return { outcome: 'rejected' };

      const decision = resolveSendOutcome(sendDuringReply, isGeneratingRef.current);

      if (decision === 'queue') {
        const queue = sendQueueRef.current;
        if (!queue) return { outcome: 'rejected' };
        // REQ-5/REQ-6 — accept and wait, visibly; the settle handlers drain the
        // FIFO exactly once (synchronous dequeue before dispatch).
        const result = queue.enqueue(text);
        setQueuedSendCount(queue.size());
        return result;
      }

      if (decision === 'interrupt') {
        // #2892 ST-4 declared defect fix (REQ-7) — supersede LOGICALLY: release
        // the in-flight generation's pending hold timer and invalidate its id so
        // its late tokens/callbacks and its 5 s happy timer can never mutate or
        // clear the NEW reply.
        clearTimer();
        generationRef.current += 1;
        isGeneratingRef.current = false;
      }

      runGeneration([
        { role: 'system', content: FREDO_CHAT_PERSONA },
        { role: 'user', content: text },
      ], true);
      return { outcome: 'dispatched' };
    }, [runGeneration, sendDuringReply, clearTimer, setQueuedSendCount]);

    // #2897 ST-3 (REQ-5) — the model-audio dispatch entry. Runs ONE fresh turn
    // whose last user message carries the captured clip (the backend renderer
    // attaches the single `input_audio` part — NO transcript text is fabricated);
    // the reply streams on the same channels as `ask`. The audio turn cannot join
    // the TEXT FIFO, so an in-flight generation is superseded through the SAME
    // logical-interrupt path `ask` uses (never dropped, never a second route).
    const askWithAudio = useCallback((clipBase64: string): CompanionSendResult => {
      announceGenerationRef.current = true;
      // A teleport owns the entity: there is no generation to stream into, so the
      // clip is not accepted (the caller keeps the clip rather than losing it).
      if (isTeleportingRef.current) return { outcome: 'rejected' };

      if (isGeneratingRef.current) {
        clearTimer();
        generationRef.current += 1;
        isGeneratingRef.current = false;
      }

      runGeneration([
        { role: 'system', content: FREDO_CHAT_PERSONA },
        { role: 'user', content: '' },
      ], false, clipBase64);
      return { outcome: 'dispatched' };
    }, [runGeneration, clearTimer]);

    // #2883 ST-6 (R-4.1/R-4.2/R-4.3) — the surface protection handlers. The
    // pointer and the keyboard are tracked as SEPARATE sources, so focus inside the
    // reply protects it independently of the pointer (and vice-versa). They are
    // bound on the entity-owned surface wrapper below (the reply's AT + focus
    // scope) AND forwarded to the bubble through the plan-declared additive props.
    const handleReplyPointerEnter = useCallback(() => enterReplyProtection('pointer'), [enterReplyProtection]);
    const handleReplyPointerLeave = useCallback(() => leaveReplyProtection('pointer'), [leaveReplyProtection]);
    const handleReplyFocus = useCallback(() => enterReplyProtection('focus'), [enterReplyProtection]);
    const handleReplyBlur = useCallback(() => leaveReplyProtection('focus'), [leaveReplyProtection]);

    const handle = useMemo<CompanionEntityHandle>(() => ({
      surface,
      requestTeleport,
      teleportTo: startTeleportOut,
      arrive,
      leaveWindow,
      playLeave,
      ask,
      askWithAudio,
    }), [surface, requestTeleport, startTeleportOut, arrive, leaveWindow, playLeave, ask, askWithAudio]);

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

    // Prefer the live streaming message; fall back to context message.
    // Strip any model control tokens that may leak through (e.g. <end_of_turn>).
    // #2886 round 2 (F3): computed ABOVE the surface gate so the visibility
    // reporter below is an UNCONDITIONAL hook (hooks may not sit after an early
    // return). The gate's own behaviour is unchanged.
    const displayMessage = (streamingMessage ?? message)
      ?.replace(/<end_of_turn>|<start_of_turn>/g, '').trimEnd() || null;

    // #2886 round 2 (F3) — ONE reporter for "a message surface is on screen".
    // The launcher consumes it to keep the app tiles mounted (and measurable) for
    // the whole reply display. Keyed on `displayMessage != null` — the exact
    // condition the surface exists under — and reports `false` on the transition
    // away and on unmount, so the tiles can never stay stuck on.
    const messageVisible = displayMessage != null;
    useEffect(() => {
      onMessageVisibilityChange?.(messageVisible);
      return () => {
        if (messageVisible) onMessageVisibilityChange?.(false);
      };
    }, [messageVisible, onMessageVisibilityChange]);

    // ── Surface-scoped render gate (#2870 ST-2b) ──────────────────────────────
    // `overlay` is the AWAY overlay: it renders only in the window that hosts
    // Fredo, only while the role is ON (`isVisible`) and he is not auto-hidden.
    // `seat` is the home seat — its consumer (the launcher slice) owns when to
    // render it, so this surface is never gated by `isHosting`, `isAutoHidden`,
    // or away.
    if (surface === 'overlay') {
      if (!isVisible || isAutoHidden || !isHosting) return null;
    }

    // Real rendered layout size for the bubble anchor + click box (offsetWidth/
    // offsetHeight — immune to the CSS transform animations on the wrapper).
    const { width: avatarWidth, height: avatarHeight } = getAvatarSize();

    // #2883 ST-6 — the plan-declared ADDITIVE bubble props (ST-4 attaches them to
    // the card). Passed only for the entity-owned reply: the wrapper-owned copy
    // (the pointer handlers are idempotent, and the mouse alone must be a no-op on
    // the welcome bubble / the game). The keyboard source lives on the wrapper.
    const surfaceProtectionProps: ReplySurfaceProtectionProps = replyOnScreen
      ? {
          onSurfaceEnter: handleReplyPointerEnter,
          onSurfaceLeave: handleReplyPointerLeave,
          onSurfaceFocus: handleReplyFocus,
          onSurfaceBlur: handleReplyBlur,
        }
      : {};

    return (
      <>
        {/* #2871 a11y (REQ-15 / DR-6): the bubble is DECORATIVE to assistive tech —
            its streamed text is announced through the single polite live region
            below, so the reply can never double-announce per token. The wrapper is
            static (the seat bubble still positions against the consumer's
            `position: relative` slot).
            #2883 ST-6 (R-4.3 / a11y): while THIS entity's reply is on screen the
            wrapper becomes the reply's AT + focus scope — `aria-hidden` is dropped,
            and it is a named `role="region"` with `tabIndex={0}` so a screen-reader
            keyboard user can Tab straight to the reply and re-read it (and so
            keyboard focus protects it, R-4.3). The TicTacToe case keeps today's
            handling exactly (interactive board, no reply region), and the
            context-owned welcome bubble stays byte-identical (aria-hidden kept). */}
        <div
          data-testid="fredo-companion-surface"
          aria-hidden={showTicTacToe || replyOnScreen ? undefined : 'true'}
          role={replyOnScreen ? 'region' : undefined}
          aria-label={replyOnScreen ? "Fredo's reply" : undefined}
          tabIndex={replyOnScreen ? 0 : undefined}
          onFocus={replyOnScreen ? handleReplyFocus : undefined}
          onBlur={replyOnScreen ? handleReplyBlur : undefined}
          onPointerEnter={replyOnScreen ? handleReplyPointerEnter : undefined}
          onPointerLeave={replyOnScreen ? handleReplyPointerLeave : undefined}
        >
          <SpeechBubble
            {...surfaceProtectionProps}
            // #2883 ST-4 — the band reaches the bubble (the launcher measured it
            // and ST-2 handed it to this entity). `undefined` ⇒ today's card.
            growth={replyBounds}
            // #2886 ST-2 — the measured avatar footprint; the bubble derives the
            // placement from it (never from the empty `fredo-companion-surface`
            // wrapper). `undefined` before the first measurement ⇒ today's card.
            avatarRect={avatarRect ?? undefined}
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
      </>
    );
  },
);

CompanionEntity.displayName = 'CompanionEntity';
