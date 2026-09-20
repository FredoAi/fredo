import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useBreakpointValue } from '@chakra-ui/react';

// Own-kernel window list (Spec #2807 ST-1) — AC1: never the third-party toolbar.
import { useWindows } from '../../../../shared/window-system/useWindows';
// Live stream/connection flag — mirrors StreamStatus.tsx (ONLINE dot).
import { useConnectionStatus } from '../../../../shared/contexts/StreamContext';
// Companion designated presence — gates the launcher mascot (#2853 ST-4).
import { useCompanion } from '../../../../shared/contexts/CompanionContext';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';

// Spec #2899 ST-1 — the desktop background registry. `none` resolves to the
// shipped grid texture (ONE definition, shared with the launcher surface).
import { NONE_BACKGROUND } from '../background/backgroundRegistry';
// Spec #2899 ST-3 / #2905 ST-1 — the selected background id. While a non-`none`
// background is active the surface drops BOTH the shipped grid texture and any
// veil (the pattern lives ONLY in the z=0 `DesktopBackdrop` layer, so it can
// never lift above a window at SURFACE_Z_OPENED and the backdrop is fully
// visible through this transparent surface).
import { useBackgroundId } from '../background/backgroundStore';

import { LauncherChrome } from './LauncherChrome';
import { LauncherAppGrid } from './LauncherAppGrid';
import { publishLauncherRegion } from '../../../../shared/components/companion/companionGeometry';
import { LauncherCommandBar } from './LauncherCommandBar';
import type { HoldCue, LauncherEnterMode } from './LauncherCommandBar';
import { EmptySeat } from './EmptySeat';
import { AVATAR_SM_CSS, FredoAvatar, type FredoAvatarState } from '../../../../shared/components/fredo-avatar';
import {
  CompanionEntity,
  askActiveCompanion,
  askActiveCompanionWithAudio,
} from '../../../../shared/components/companion';
import {
  modelAudioFailureCopy,
  MODEL_AUDIO_FAILURE_COPY,
  MODEL_AUDIO_GENERIC_FAILURE,
} from '../../../../shared/components/companion/companionReadiness';
import type { ModelAudioFailureCode } from '../../../../shared/components/companion/companionReadiness';
import { adapterBridge } from '../../../../shared/utils/adapterBridge';
// Spec #2883 ST-2/ST-3 — the reply band's contract type + margin come from the
// pure reply-layout module (ONE source of truth for the launcher → entity →
// bubble hand-off; the layout maths itself is ST-3/ST-4's).
import {
  REPLY_MARGIN,
  type ReplySurfaceBounds,
} from '../../../../shared/components/companion/replySurfaceLayout';
import { useFredoRestingCadence } from '../../../../shared/hooks/useFredoRestingCadence';
// Spec #2877 ST-5 — the launcher-origin capture cue. Spec #2882 ST-4 retires the
// context-dependent Ctrl+Space cascade. Spec #2914 ST-5 — the model-audio path is
// the ONE speech path, so this hook carries `stt:state` only (no transcript).
import { useVoiceDictation } from '../../../../shared/hooks/useVoiceDictation';
// Spec #2882 ST-1 — THE ONE pure Enter decision. Both the hint memo and the commit
// path consume it, so the chip can never promise a different action than Enter takes
// (R-6.3). The rule is never re-derived locally.
import {
  enterHintLabel,
  findTopRankedMatch,
  resolveEnterAction,
} from './launcherEnterAction';
// Spec #2882 ST-2 — the PURE hold-Space gesture decision. The shell owns the
// DOM/timer/mic wiring; the precedence stays in the tested module (a Space may
// only be consumed under the FULL R-2.1 precondition, and every release resolves
// to at most ONE ordinary space — the typing-safety NFR, R-2.6/R-2.7).
import {
  HOLD_PENDING_CUE_MS,
  HOLD_THRESHOLD_MS,
  resolveSpaceKeyDown,
  resolveSpaceKeyUp,
  spaceWriteForVerdict,
} from './launcherSpaceHold';

/**
 * LauncherShell — the Fredo-owned launcher host (Spec #2808 ST-1; Spec #2821
 * ST-5 structural hoist).
 *
 * Replaces the third-party `Toolbar` (`DesktopToolbar.tsx`). This is the
 * full-screen desktop surface. It uses a 2-state reveal model (#2819):
 *
 *   - Resting Main (`engaged=false`): chrome + pixel-butler avatar + `>`
 *     search-or-command bar; NO app grid, NO keyboard hints. This is the
 *     default at launch (fixes the blank-desktop first impression).
 *   - Engaged    (`engaged=true`): resting surface + the `| APPS` grid and the
 *     keyboard-nav hints (revealed when the command bar is focused or a query
 *     is present).
 *
 * AC5 (persistent search/command, Spec #2821 ST-5): the resting Main surface
 * is HOISTED to the shell ROOT and is ALWAYS mounted — it is never gated by an
 * `open` boolean, so closing a feature window never unmounts the search bar
 * (`bugs/launcher-disappears.png` is the fail state). Instead of collapsing on
 * window-open, the whole surface is placed BELOW the window stack (a maximized
 * feature window legitimately covers it — `Home.tsx:91`), and is simply
 * re-revealed when no non-minimized window covers it. The idle/engaged
 * grid-reveal model, keyboard-nav, and the `—` MINIMIZE control are preserved.
 *
 * The host owns the shared state (engaged, query, selected tile index) and the
 * keyboard-nav orchestration (↑↓ / ←→ / Enter / Space / Esc). It reads the
 * live own-kernel window list via `useWindows()` (used both to re-z the surface
 * behind maximized windows and to sink the grid when one opens) and dispatches
 * every tile open through `onOpenFeature` → Home's full-lifecycle opener (never
 * raw `openWindow`), preserving feature close-on-unmount / self-open / rerender
 * wiring (Home.tsx:77-129).
 *
 * The grid's empty guard (AC4) + the command-bar filter means arrows/Enter/
 * Space are NO-OPs whenever there is no selectable entry: `showableFeatures`
 * empty (AC4) OR the query filters every tile out — keyboard never opens a tile
 * that does not exist.
 */

export interface LauncherShellProps {
  /** Fredo's real showable features (Home.tsx:22 — SHOWABLE_FEATURES). */
  showableFeatures: FredoFeatureClass[];
  /** Routes a selected tile to the own-kernel full-lifecycle opener (Home.tsx). */
  onOpenFeature: (id: string, feature: FredoFeatureClass) => void;
}

const clampIndex = (value: number, len: number): number =>
  Math.min(Math.max(0, value), len - 1);

/** The command-bar `role="searchbox"` field is the grid-navigation focus anchor.
 *  Spec #2883 ST-2: the field became a `Textarea`, so the anchor is the ROLE
 *  alone (tag-agnostic) — a tag-qualified selector would silently stop matching
 *  and break Ctrl+Space, hold-Space and the Space-does-not-open-a-tile guard. */
const SEARCHBOX_SELECTOR = '[role="searchbox"]';
const NOTCH_SELECTOR = '[role="button"][aria-label="Fredo launcher"]';

/** Spec #2883 ST-2 — the bar field's tag set (`INPUT` before #2883, `TEXTAREA`
 *  after). Routing every tag-shaped check through this ONE set is what keeps the
 *  #2882 keyboard contract (hold-Space arming, the Ctrl+Space caret rule, the
 *  Space-never-opens-a-tile guard) intact across the element swap. `.value` and
 *  `.setSelectionRange` exist on both tags, so the caret rule is preserved. */
const BAR_FIELD_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA']);
const isBarFieldTag = (el: Element | null): boolean => !!el && BAR_FIELD_TAGS.has(el.tagName);

/** Surface stacking: resting Main above the (transparent) window stack when it
 *  is not covered; dropped BELOW it once a maximized feature window covers the
 *  desktop (AC5 — a maximized window legitimately covers the surface). */
const SURFACE_Z_VISIBLE = 1100;
const SURFACE_Z_COVERED = 0;
/** #2823 open level: the shortcut-opened launcher MUST rise above the window
 *  stack (WindowManager z=1) AND above the chrome (z=1200) / StreamStatus
 *  (z=1210) so a maximized covering window never obscures it (AC1 "opens on
 *  top" over a maximized window). Only the SHORTCUT-open state uses this; the
 *  closed state preserves the resting z-sink (coveredByWindow). */
const SURFACE_Z_OPENED = 1300;

/** #2854 ST-4: the desktop mascot's bounded `happy` beat on a feature-tile open.
 *  A single cleared `setTimeout` (no interval/loop) then returns to the rest
 *  expression; `desktopState` priority keeps it above `thinking`. */
const DESKTOP_HAPPY_BEAT_MS = 1600;

/** #2823 AC3: true for any text-editing control — the "another input" guard.
 *  The launcher's own searchbox is an `input`, so this predicate ALONE is not
 *  sufficient; it must be paired with an overlayRef containment check (NFR-7). */
const isTextControl = (el: Element | null): boolean =>
  !!el &&
  (el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true);

/** #2823 REQ-5 / NFR-4: connected AND focusable target for focus restore.
 *  Excludes `body` (tabIndex -1), disabled, aria-disabled and detached nodes so
 *  focus is never restored onto a stale/unmounted reference. */
const isFocusable = (el: HTMLElement | null): boolean =>
  !!el &&
  el.isConnected &&
  el.tabIndex >= 0 &&
  !(el as HTMLInputElement).disabled &&
  el.getAttribute('aria-disabled') !== 'true';

/**
 * Spec #2883 ST-2 — the launcher-measured REPLY BAND (`ReplySurfaceBounds`).
 *
 * The seat reply surface may grow, but only inside a band the LAUNCHER owns:
 *   - `safeTop`    — under the chrome notch (58px) plus the band margin;
 *   - `barrierTop` — the command bar's box top; the reply's bottom edge stays
 *                    `<= barrierTop - REPLY_MARGIN` (R-2.3, zero intersection
 *                    with the bar, its field, the hint and the collapse control);
 *   - `boundsLeft` / `boundsRight` — the launcher column's padding box inset by
 *                    the margin (the column is `overflow:auto`, so its box is the
 *                    cross-axis clip box too — R-2.2).
 *
 * The TYPE and the margin come from the pure reply-layout module (ST-3), so the
 * launcher → entity → bubble hand-off has ONE contract. `undefined` = "not
 * measured yet" and leaves today's fixed rendering exactly (R-5.3).
 */
/** The chrome notch's height: the band's `safeTop` is its bottom plus the margin. */
const NOTCH_HEIGHT_PX = 58;

/**
 * Numeric equality for the band — the AGENTS.md #523 loop guard. Exported so the
 * "write the band state only when a number actually changes" contract is
 * unit-pinned: a re-measure that changed nothing must NOT write state (a state
 * write per frame/keystroke is exactly the re-render-loop class).
 */
export function replyBoundsEqual(a: ReplySurfaceBounds, b: ReplySurfaceBounds): boolean {
  return (
    a.safeTop === b.safeTop &&
    a.barrierTop === b.barrierTop &&
    a.boundsLeft === b.boundsLeft &&
    a.boundsRight === b.boundsRight
  );
}

/**
 * Spec #2882 ST-4 — Ctrl+Space has ONE meaning: show/focus the bar.
 *
 * The shipped #2877 context-dependent cascade (`companion-listen` /
 * `launcher-listen` / `launcher-cancel`) is RETIRED (R-1.2/R-1.4): the chord is
 * never a listening control, never closes the bar, and never starts a
 * companion-origin session. What survives is the #2823 AC-3 carve-out — a
 * focused text control OUTSIDE the launcher still receives the chord untouched
 * (`pass`: no `preventDefault`, no text mutation).
 *
 * The predicate is PURE and takes only what it needs, so the retired branches
 * cannot be reintroduced by a stale context field.
 */
export type CtrlSpaceAction = 'open' | 'pass';

export interface CtrlSpaceContext {
  /** A text-editing control (input/textarea/select/contenteditable) has focus. */
  activeIsTextControl: boolean;
  /** …and that control lives INSIDE the launcher surface (the launcher bar). */
  activeInLauncher: boolean;
}

export function selectCtrlSpaceAction(ctx: CtrlSpaceContext): CtrlSpaceAction {
  // The #2823 AC3 carve-out — typing in a text control OUTSIDE the launcher: do
  // not act and do not swallow the chord.
  if (ctx.activeIsTextControl && !ctx.activeInLauncher) return 'pass';
  // Every other context (including the launcher's own focused bar): show/focus
  // the bar. Ctrl+Space NEVER starts/stops listening and NEVER closes it.
  return 'open';
}

/**
 * Spec #2887 ST-7 (R-3/AC3) — THE ONE honest hold-cue derivation, pure and
 * unit-pinned so the shell can never hand the bar a cue that claims capture
 * before it exists:
 *
 *   captureLive (the `listening` prop = `voice.listening && origin === 'launcher'`)
 *       → `'listening'` — the ONLY state that may render `Listening`/`Listening…`
 *         or the listening announcer (the bar clamps it too, belt-and-braces);
 *   pending (`holdPending` — the shipped bounded gate, armed INSIDE the
 *   `HOLD_THRESHOLD_MS` timer's callback, so it is measured from
 *   THRESHOLD-CROSSED, never from the keydown)
 *       → `'starting'` when the engine is resident (the hold is paying only the
 *         capture-open), `'warming'` when it is NOT (`engineResident === false`:
 *         the launch window, where the hold joined the in-flight setup warm).
 *         Both render the SAME bounded `starting voice input…` chip — the
 *         distinction is the honest cause, never a longer "starting" affordance;
 *   armed (the keydown edge, before the threshold cross)
 *       → `'acknowledge'` — `Hold to dictate…`, the user's own gesture, no
 *         capture mark and no listening wording;
 *   otherwise
 *       → `'none'`.
 *
 * The warm-path turnaround is shorter than the 150 ms bounded cue, so the whole
 * readying window on a warm/instant start is the single `'acknowledge'` state —
 * there is no "starting" dwell to be perceived as a stall.
 */
export function deriveHoldCue(input: {
  /** The launcher-origin capture is genuinely live (never inferred from the gesture). */
  captureLive: boolean;
  /** A hold is armed (the qualifying keydown happened; the gesture owns the Space). */
  armed: boolean;
  /** The bounded pending gate fired: threshold crossed + `HOLD_PENDING_CUE_MS`. */
  pending: boolean;
  /** ST-3's `stt:state` stamp: the last start took the resident engine. */
  engineResident: boolean;
}): HoldCue {
  if (input.captureLive) return 'listening';
  if (input.pending) return input.engineResident ? 'starting' : 'warming';
  if (input.armed) return 'acknowledge';
  return 'none';
}

/**
 * Spec #2897 ST-6 — the `stt_take_audio_clip` wire shape the delivery glue
 * consumes (ST-2). `clip` is the WHOLE captured 16 kHz mono PCM WAV, base64;
 * `code`/`detail` are the additive failure fields.
 */
export interface SttAudioClipResult {
  clip: {
    base64: string;
    format: string;
    sampleRate: number;
    durationMs: number;
    limitMs: number;
    atLimit: boolean;
    truncated: boolean;
  } | null;
  code: string | null;
  detail: string | null;
}

/**
 * Spec #2877 ST-5 (DR-11) — curated, actionable copy for a failed `stt_start`.
 * The typed `SttErrorCode` is the only primary key; a raw IPC detail is never
 * the primary sentence. Non-blocking: the app stays fully usable, no session
 * starts, and the enablement preference is never silently flipped.
 *
 * Spec #2897 ST-6 (REQ-7) — the two model-audio codes carry the SAME curated
 * degradation copy as the settings readiness row and the inline fallback action.
 */
export function voiceStartErrorCopy(code: string | null): string | null {
  switch (code) {
    case 'permissionDenied':
      return 'Microphone access is blocked — allow it in Windows Settings → Privacy → Microphone, then try again.';
    case 'noDevice':
      return 'No microphone found. Connect a microphone, then try again.';
    case 'modelMissing':
    case 'modelCorrupt':
      return "Voice input model isn't ready — open Companion settings to install it.";
    case 'engineStartFailed':
      return "Voice input couldn't start. Try again; if it persists, re-check the model in Companion settings.";
    case 'disabled':
      return 'Voice input is off. Turn it on in Companion settings.';
    case 'alreadyListening':
      return 'Voice input is already listening.';
    // Spec #2897 ST-6 (REQ-7) — the curated model-audio degradation copy. The
    // raw IPC detail is NEVER the primary sentence; these are the SAME strings
    // the settings row and the inline fallback action read.
    case 'modelAudioUnsupported':
      return MODEL_AUDIO_FAILURE_COPY.modelAudioUnsupported;
    case 'modelAudioUnavailable':
      return MODEL_AUDIO_FAILURE_COPY.modelAudioUnavailable;
    case 'internal':
      return 'Voice input hit an unexpected problem. Try again.';
    default:
      return null;
  }
}

/** Subtle dot/tick grid texture (Asset 1.7) — moved VERBATIM to the background
 *  registry as `NONE_BACKGROUND.css` (Spec #2899 ST-1) so the shipped `none`
 *  look has ONE definition. The overlay is z-gated below the window stack when
 *  covered. */

export const LauncherShell: React.FC<LauncherShellProps> = ({ showableFeatures, onOpenFeature }) => {
  const currentWindows = useWindows();
  // #2899 ST-3 — the desktop surface's fill is conditional on the selection
  // (see `surfaceCss` below): `none` keeps today's exact texture, any procedural
  // background yields a token-derived scrim over the z=0 backdrop.
  const backgroundId = useBackgroundId();
  const { isConnected } = useConnectionStatus();
  const {
    state: companion,
    voiceEnabled,
    replyInFlight,
    queuedSendCount,
  } = useCompanion();
  // Spec #2914 ST-5 — ONE speech path. The captured model audio IS the turn's
  // input (delivered loopback to the local multimodal server); there is no
  // transcript and no local transcription mode (`voiceHandling` is gone from
  // CompanionContext — R-4), so the bar is rendered in model-audio mode.

  // #2870 ST-3: the home seat slot is ALWAYS reserved at a fixed 80×100 + 16px
  // band (the wrapper below owns the size + `mb="4"`), so the command bar's
  // geometry is identical across every state. The slot CONTENT is chosen from
  // the two transient presence booleans — primitive reads only (never an object
  // identity / array `.length`, AGENTS.md #523):
  //   OFF  (`!isVisible`)                  → the decorative idle mascot (unchanged)
  //   ON + at home (`isVisible && !isAway`) → the interactive companion in the seat
  //   ON + away (`isVisible && isAway`)     → the static EmptySeat placeholder
  // `isAway` is the canonical location flag (#2870 ST-1): a teleport (within a
  // window, or a cross-window hand-off) leaves the seat; a role change / idle
  // auto-return brings Fredo home. Deliberately INDEPENDENT of `isInThisWindow`:
  // the companion may live in the terminal window while the mascot lives here.
  const companionVisible = companion.isVisible;
  const companionAway = companion.isVisible && companion.isAway;
  // #2871 ST-2 (binding predicate — the #2870 seat render gate): the companion
  // is ACTIVE in THIS window iff he is designated present and NOT away. `isAway`
  // alone is the seat-render gate; `!isAutoHidden` is deliberately NOT included
  // (after an idle auto-return the reducer sets `isAway:false, isAutoHidden:true`
  // while the interactive seat still renders, so gating on it would dead-lock
  // chat after the first idle return). Home-after-auto-return is ACTIVE.
  const companionActive = companion.isVisible && !companion.isAway;
  // #2892 ST-5 (AC2/AC3) — the truthful "replying" primitive. `isInUse` (which
  // ALSO covers the #2883 read-hold when the pointer rests on a completed reply)
  // no longer fakes a generation: only `replyInFlight` is busy. `isInUse` stays
  // untouched inside CompanionContext for idle auto-return suppression (AC4).
  // Primitive read only (AGENTS.md #523).
  const companionReplying = replyInFlight;

  // Spec #2882 ST-4 — Ctrl+Space shows/focuses the bar (see `selectCtrlSpaceAction`);
  // the launcher-origin listening cue (DR-7) is unchanged. `start`/`stop`/`cancel`
  // are stable useCallbacks, so the document listener below keeps a stable identity
  // and is mounted exactly once (NFR-2).
  const voice = useVoiceDictation();
  // Spec #2882 ST-5 — CT-1: the hold gesture is now the ONLY launcher capture
  // entry point (ST-4 retired every Ctrl+Space listening branch, ST-6 retired the
  // companion-origin path), so `start` is wired to the hold timer's arm path.
  const { start: startVoice, stop: stopVoice, cancel: cancelVoice } = voice;
  // Spec #2914 ST-5 (R-3) — the arming gate is `voiceEnabled` ONLY. The deleted
  // sherpa `stt_check_model`/`stt_warm` readiness probe no longer withholds the
  // gesture; the backend's `model_audio_start_gate` / `stt_audio_capability`
  // owns any start-time degradation, and a hold must always be able to arm.
  // Spec #2882 ST-5-fix (QA-10) — WHILE a launcher-origin capture is live, Enter is
  // a NO-OP and the chip reads exactly `release Space to finish`. This ONE primitive
  // is fed to the SAME `resolveEnterAction` on BOTH the hint path (the memo) and the
  // handler path (the Enter branch) and drives the bar cue below, so the chip can
  // never contradict what Enter does (R-6.3) — there is no second copy table.
  const captureLive = voice.listening && voice.origin === 'launcher';
  // Latest-value ref for the mounted-once listener (mirrors `openRef`): its handler
  // identity is stable, so any non-ref read inside it would be stale. The retired
  // `companionAwayRef` / `voiceEnabledRef` went with the cached cascade branches.
  const listeningRef = useRef(voice.listening);

  // ── Spec #2878 ST-1 — commit-path support refs ─────────────────────────────
  // Mutable refs (never state) so they can be read/written synchronously inside
  // effects in the SAME commit. Deps stay primitives (AGENTS.md #523).
  //
  // `barTextRef` mirrors the controlled bar query synchronously so the release
  // owner's ordinary-space write reads the current text.
  const barTextRef = useRef('');
  // Spec #2914 ST-5 — the discard target: the bar text present BEFORE the
  // capture started, restored by a cancel/voice-disabled teardown. In the single
  // model-audio path the bar is never transcript-written, so this is the
  // shipped cancel behavior (a user edit during the capture is still restored).
  const preSessionTextRef = useRef('');
  const launcherActiveRef = useRef(false);

  // #2819 FIXED: the shell surface is visible by default at launch (idle), so a
  // fresh launch shows the avatar + command bar instead of a blank desktop.
  // Grid + keyboard-hints sub-state: reached when the command bar is focused or a
  // query is present; returns to idle on ESC / focus-leaving-the-surface (empty query).
  const [engaged, setEngaged] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // #2823: shortcut-opened overlay state — DISTINCT from the #2819 `engaged`
  // grid-reveal. `open` is TRUE only when the launcher was summoned by Ctrl+Space
  // (it re-z's above the window stack + autofocuses the searchbox). When FALSE the
  // resting z-model (coveredByWindow) applies unchanged.
  const [open, setOpen] = useState(false);

  // Spec #2887 follow-up (UI/UX §4 S4) — the CANCEL signal handed to the bar's
  // live region. A monotonic counter (never a boolean) so each live Escape / `×`
  // is a distinct transition the bar announces exactly once. Bumped ONLY when a
  // GENUINELY LIVE launcher-origin session is discarded (`listeningRef` true): an
  // Escape that merely disarms a pre-capture hold claims nothing, so it stays
  // silent (UI/UX §3 flow 6 — nothing to retract).
  const [cancelSignal, setCancelSignal] = useState(0);
  const signalCancel = useCallback(() => setCancelSignal((n) => n + 1), []);

  // ── Spec #2882 ST-5 — the hold-to-dictate gesture state (never persisted) ────
  // The WHILE-Space-is-held condition is a continuous state machine, not a set of
  // transition call-sites: `holdArmed` is the cue from the keydown moment for the
  // WHOLE gesture (R-2.4), `holdPending` is the bounded `starting voice input…`
  // chip once the engine start outlives `HOLD_PENDING_CUE_MS` (S2). One release
  // owner: the mount-once document keyup listener below (inert outside a hold).
  const [holdArmed, setHoldArmed] = useState(false);
  const [holdPending, setHoldPending] = useState(false);
  // R-2.1 / contract 4c — the promise placeholder is offered only when the whole
  // precondition is available (voice on + not busy). Spec #2914 ST-5 (R-3): the
  // sherpa model-readiness term is gone — the gesture is gated on `voiceEnabled`
  // alone and the backend owns start-time degradation.
  const holdAvailable = voiceEnabled && !companionReplying;
  // Spec #2887 ST-7 (R-3/AC3) — the ONE honest cue, derived from the pure
  // `deriveHoldCue` rule (see its doc). It replaces the shipped
  // `holdArmed`/`holdPending` pair at the bar: `'listening'` is reachable ONLY
  // while `captureLive`, so the pre-#2887 defect (armed → `Listening…`) can
  // never recur — the armed window acknowledges the gesture in the user's own
  // words and the readying window names what is actually happening.
  const holdCue = deriveHoldCue({
    captureLive,
    armed: holdArmed,
    pending: holdPending,
    engineResident: voice.engineResident,
  });
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdPendingCueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdArmedRef = useRef(false);
  // Escape / the visible `×` disarmed this gesture: swallow Space until the release.
  const holdDisarmedRef = useRef(false);
  // The release-resolution inputs (R-2.6 vs R-2.7).
  const thresholdCrossedRef = useRef(false);
  // Went live DURING this gesture — a live-then-stopped release is a FINALIZE,
  // never a cancel-and-space.
  const holdWentLiveRef = useRef(false);
  // The release landed before the engine confirmed the start: cancel the session
  // on its rise edge. `stt_stop`/`stt_cancel` with NO active session is a silent
  // no-op (session.rs:357-388), so without this the microphone stays hot.
  const cancelOnLiveRef = useRef(false);
  // R-2.5 — one blur stop per gesture (the input's focusout and a `window` blur
  // can both report the same gesture).
  const blurStopIssuedRef = useRef(false);

  // The gesture's two bounded timers — always cleared together (no leaked timer).
  const clearHoldTimers = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdPendingCueTimerRef.current) {
      clearTimeout(holdPendingCueTimerRef.current);
      holdPendingCueTimerRef.current = null;
    }
  }, []);

  // End the gesture's timers + cue state WITHOUT touching the session (the caller
  // owns stop/cancel). Never writes a space — the release owner does that.
  const resetHoldGesture = useCallback(() => {
    clearHoldTimers();
    holdArmedRef.current = false;
    thresholdCrossedRef.current = false;
    holdWentLiveRef.current = false;
    setHoldArmed(false);
    setHoldPending(false);
  }, [clearHoldTimers]);

  // R-2.1 — arm the hold: the caller has already consumed the keydown
  // (`preventDefault`), the bounded HOLD_THRESHOLD_MS timer starts here, and every
  // further Space keydown is swallowed until the release (R-2.2).
  const armHold = useCallback(() => {
    holdArmedRef.current = true;
    holdDisarmedRef.current = false;
    thresholdCrossedRef.current = false;
    holdWentLiveRef.current = false;
    cancelOnLiveRef.current = false;
    blurStopIssuedRef.current = false;
    setHoldArmed(true);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      thresholdCrossedRef.current = true;
      // S2 — the pending chip appears only if the engine start outlives the
      // bounded cue window (Doherty: the loop must never look dead).
      holdPendingCueTimerRef.current = setTimeout(() => {
        holdPendingCueTimerRef.current = null;
        if (!launcherActiveRef.current) setHoldPending(true);
      }, HOLD_PENDING_CUE_MS);
      // R-2.1 — a LAUNCHER-origin capture (the only capture entry point, R-1.4).
      void startVoice('launcher');
    }, HOLD_THRESHOLD_MS);
  }, [startVoice]);

  // R-2.5 (QA-9 CLOSED) — a blur during a hold/capture is a STOP, never a
  // discard: the capture stops and the microphone is released. Spec #2914 ST-5 —
  // with no transcript there is nothing to keep or autosend; the bar text is
  // never touched by a blur. Discard + restore applies ONLY to an explicit cancel
  // (Escape / the visible `×`).
  const stopCaptureOnBlur = useCallback(() => {
    if (blurStopIssuedRef.current) return;
    const live = launcherActiveRef.current;
    const crossed = thresholdCrossedRef.current;
    const armed = holdArmedRef.current;
    if (!live && !crossed && !armed) return;
    blurStopIssuedRef.current = true;

    if (live) {
      // The trailing keyup must not write a space or re-issue a stop.
      holdDisarmedRef.current = true;
      resetHoldGesture();
      void stopVoice();
      return;
    }
    if (crossed) {
      // Threshold crossed, engine not confirmed: cancel on the rise edge so the
      // microphone is never left capturing, and drop the gesture (no space — a
      // blur is not a release).
      holdDisarmedRef.current = true;
      cancelOnLiveRef.current = true;
      resetHoldGesture();
      return;
    }
    // Merely armed (the release had not beaten the threshold yet): still a TAP.
    // Only the pending start is cancelled; the trailing keyup resolves it so the
    // space the user meant to type is never lost (R-2.7 / the typing-safety NFR).
    clearHoldTimers();
  }, [clearHoldTimers, resetHoldGesture, stopVoice]);

  // #2854 ST-4: the desktop mascot's SURFACE-LOCAL expression state (never the
  // companion context / `CompanionState` / presence payload — #2853 invariant).
  // `happy` is a bounded beat on a feature-tile open; `thinking` while the
  // command bar is engaged OR a non-empty query is present; `playful` on the
  // shared resting cadence. Priority: happy > thinking > playful > idle.
  const [desktopMoment, setDesktopMoment] = useState<'happy' | null>(null);
  const desktopMomentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandActive = engaged || query.trim() !== '';
  const restingPhase = useFredoRestingCadence(commandActive, { delayMs: 12000, holdMs: 1800 });
  const desktopState: FredoAvatarState =
    desktopMoment === 'happy' ? 'happy' : commandActive ? 'thinking' : restingPhase;

  const overlayRef = useRef<HTMLDivElement | null>(null);
  // ── Spec #2883 ST-2 — the launcher-measured reply band ─────────────────────
  // The launcher owns the geometry the seat reply surface must stay inside, so it
  // measures the band and passes it launcher → entity → bubble. Refs (never
  // render state) for the two measured boxes; `replyBounds` is written ONLY when
  // a number actually changes (the AGENTS.md #523 loop guard).
  const columnRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  // #2886 ST-4 — the app-tiles grid's RESTING box. The tiles render below the
  // bar, so folding the grid's top into `barrierTop` is the tiles' keep-out: a
  // reply that respects the barrier is already above every tile row. Measured in
  // the SAME rAF pass as the band (never a second effect/polling chain).
  const gridRef = useRef<HTMLDivElement | null>(null);
  // #2886 round 2 (F3) — the seat entity reports whether a message surface is on
  // screen. The tiles must stay MOUNTED (and therefore measurable) for the whole
  // reply display: the send path collapses `engaged`, and a hide/collapse cannot
  // pass the AC-4 keep-out check. `engaged` and everything it drives are
  // untouched — this only widens WHEN the grid renders.
  const [companionMessageVisible, setCompanionMessageVisible] = useState(false);
  const handleCompanionMessageVisibility = useCallback((visible: boolean) => {
    setCompanionMessageVisible(visible);
  }, []);
  const [replyBounds, setReplyBounds] = useState<ReplySurfaceBounds | undefined>(undefined);
  const prevWindowCountRef = useRef(currentWindows.length);
  // Suppresses re-engaging when focus is moved programmatically (ESC → refocus the
  // command bar) so the grid stays hidden while the surface returns to idle.
  const skipNextFocusEngageRef = useRef(false);
  // #2823: synchronous `open` mirror so the document keydown handler (mounted once,
  // reads the LATEST value) sees current state without the one-render lag that would
  // turn a rapid Ctrl+Space double-press into a double-open (real AC-1 edge). We
  // assign it directly inside the open/close helpers (never via an effect).
  const openRef = useRef(false);
  // #2823: focus origin captured on (shortcut) open, restored on close (REQ-5).
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // #2823: NFR-2 idempotency guard — exactly ONE document keydown listener active.
  const globalKeydownMountedRef = useRef(false);

  // #2823: close the launcher overlay WITHOUT restoring focus — used when focus has
  // already left the surface (window-open, tile-open, minimize, natural blur) so the
  // overlay drops back to the resting z-model and the grid idles. `openRef` is set
  // synchronously so the global handler never observes a stale open state.
  const closeSurface = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setEngaged(false);
  }, []);

  // #2854 ST-4: a feature-tile open fires the mascot's bounded `happy` beat. A
  // SINGLE cleared `setTimeout` (never doubled) — cleared on re-trigger and on
  // unmount, so no timer can leak (AGENTS.md #523 — no re-render loops). The
  // deps are stable (ref + setState) so the callback identity never changes.
  const triggerDesktopHappy = useCallback(() => {
    setDesktopMoment('happy');
    if (desktopMomentTimerRef.current) clearTimeout(desktopMomentTimerRef.current);
    desktopMomentTimerRef.current = setTimeout(() => {
      desktopMomentTimerRef.current = null;
      setDesktopMoment(null);
    }, DESKTOP_HAPPY_BEAT_MS);
  }, []);

  useEffect(
    () => () => {
      if (desktopMomentTimerRef.current) clearTimeout(desktopMomentTimerRef.current);
    },
    [],
  );

  // #2823: Ctrl+Space open — capture the pre-open focus origin (first-open ONLY;
  // a repeat chord while the bar is already up must not re-point Escape's restore
  // target at the searchbox itself), raise the overlay above the window stack and
  // focus the command-bar searchbox.
  //
  // Spec #2882 ST-4 (R-1.1/R-1.3, UI/UX §6) — the caret rule: when the input did
  // NOT already have focus, place the caret at the END of the existing text, so a
  // summon can never overwrite an uncommitted transcript; when it already HAD
  // focus (with a selection) the selection is left untouched — Ctrl+Space must
  // never mutate text or move an existing caret. It also NEVER closes the bar.
  const openOverlay = useCallback(() => {
    if (!openRef.current) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    }
    openRef.current = true;
    setOpen(true);
    setEngaged(true);
    window.requestAnimationFrame(() => {
      // Guard against a within-frame close (rapid double-press): only touch the
      // searchbox if the overlay is STILL open (openRef is read live, not captured).
      if (!openRef.current) return;
      // Spec #2883 ST-2 — tag-agnostic: `.value` + `.setSelectionRange` exist on
      // both the shipped `Input` and the swapped `Textarea`, so the caret-at-end
      // rule is preserved byte-for-byte across the element swap.
      const input = overlayRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        SEARCHBOX_SELECTOR,
      );
      if (!input) return;
      if (document.activeElement !== input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    });
  }, []);

  // #2823: close (ESC / toggle-off) — drop the overlay to resting (closeSurface) AND
  // restore focus to the pre-open element ONLY if focus was actually inside the
  // launcher surface at close time (UI/UX §3). If the user already moved focus out,
  // do NOT yank it back. Falls back to blur when the pre-open element is
  // stale/unfocusable (NFR-4) — never a focus-trap into a dead launcher.
  const closeOverlay = useCallback(() => {
    const active = document.activeElement;
    closeSurface();
    if (overlayRef.current?.contains(active)) {
      const prev = previousFocusRef.current;
      if (isFocusable(prev)) {
        window.requestAnimationFrame(() => {
          // Don't yank focus back if the launcher was re-opened before this frame ran
          // (rapid on→off→on): the re-open's own focus wins.
          if (!openRef.current) prev?.focus();
        });
      } else {
        (active as HTMLElement | null)?.blur();
      }
    }
  }, [closeSurface]);

  // A window covers the surface when it is shown (not minimized). Windows open
  // maximized (`Home.tsx:91`), so any open window covers the resting Main.
  const coveredByWindow = currentWindows.some((w) => !w.isMinimized);
  // Open override: the shortcut-opened overlay rises above the window stack / chrome
  // regardless of `coveredByWindow`. The CLOSED state preserves the #2821 z-sink
  // below a maximized window.
  const surfaceZ = open ? SURFACE_Z_OPENED : coveredByWindow ? SURFACE_Z_COVERED : SURFACE_Z_VISIBLE;

  // #2899 ST-3 / #2905 ST-1 — the surface keeps the shipped texture
  // byte-identically for `none`. For any procedural option the surface is
  // FULLY TRANSPARENT: the descriptor's own opaque `backgroundColor` ground (in
  // the z=0 `DesktopBackdrop`) is the opaque layer, and a translucent veil here
  // would dilute the recipe to near-invisibility (the #2905 defect: the old
  // `tint('var(--body-bg)', 72)` scrim was a 72%-opaque full-viewport veil above
  // the backdrop). The pattern is NEVER painted on this surface — at
  // SURFACE_Z_OPENED (1300) it would rise above a window.
  const surfaceCss =
    backgroundId === 'none' ? NONE_BACKGROUND.css : { backgroundColor: 'transparent' };

  // Command-bar query filters the grid by tile name (type-ahead highlight).
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return showableFeatures;
    return showableFeatures.filter((feature) => feature.name.toLowerCase().includes(q));
  }, [showableFeatures, query]);

  // Spec #2882 ST-4 — the truthful hint, derived from ST-1's ONE Enter verdict
  // (R-6.3: "the hint always states the action Enter will take"). The old
  // independent exact-full-name rule + the `companionBusy` global gate are
  // retired: the memo reads the SAME `resolveEnterAction` the handler commits,
  // so the two can never drift. One memo off primitives + the feature list
  // (AGENTS.md #523).
  //
  // `entries` is the rendered results list (`filteredEntries`); a rule match is
  // always a substring-filter match (contract 2), so `findTopRankedMatch` settles
  // on the earliest matching entry the grid shows.
  //
  // Spec #2882 ST-5-fix (QA-10) — `captureLive` is fed here too: while a launcher-
  // origin capture is live the verdict is `none/listening`, so the chip reads
  // `release Space to finish` (or `Fredo is replying…` while busy, UI/UX §3 row 1
  // outranking row 2). The Enter branch below reads the SAME verdict.
  const commandBar = useMemo<{
    enterMode: LauncherEnterMode;
    hintLabel: string | undefined;
  }>(() => {
    const queryEmpty = query.trim() === '';
    const action = resolveEnterAction({
      query,
      entries: filteredEntries,
      // Spec #2914 ST-5 — with no dictation there is no dictated provenance: bar
      // content is always typed (the resolver's `dictated` branch stays for its
      // own contract tests, but the shell never produces it).
      textOrigin: 'typed',
      companionActive,
      captureLive,
    });
    // #2892 ST-5 — `busy` is fed ONLY to express the live-capture precedence row
    // (`release Space to finish` vs `Fredo is replying…`); it never gates a send.
    const hintLabel = enterHintLabel(action, { busy: companionReplying, queryEmpty });
    const enterMode: LauncherEnterMode =
      action.kind === 'launch' ? 'launch' : action.kind === 'send' ? 'send' : 'none';
    return { enterMode, hintLabel };
  }, [query, filteredEntries, companionActive, companionReplying, captureLive]);

  // Spec #2882 ST-5-fix (UI/UX §7) — the accent-highlighted tile follows the
  // top-ranked rule match, so the tile the grid highlights is the SAME app the chip
  // names and Enter opens. This is a SEPARATE effect on purpose: the live-text
  // effect depends on `handleQueryChange`'s identity, so folding this into that
  // callback would restart partial writes mid-session. Arrow-key navigation is
  // untouched — it moves the selection WITHIN a query and this effect re-runs only
  // when the query (or the filtered list it derives from) actually changes.
  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setSelectedIndex(0);
      return;
    }
    const match = findTopRankedMatch(q, filteredEntries);
    if (!match) return;
    const index = filteredEntries.indexOf(match);
    if (index !== -1) setSelectedIndex(index);
  }, [query, filteredEntries]);

  // Responsive column count — MUST mirror LauncherAppGrid's
  // `SimpleGrid columns={{ base: 2, sm: 3, md: 4, lg: 6 }}` so ↑↓ leaps a full row.
  const columns = useBreakpointValue({ base: 2, sm: 3, md: 4, lg: 6 }) ?? 2;

  const entryCount = filteredEntries.length;
  // Clamp the rendered selection to the (possibly filtered) entry set — 0 when empty
  // so the grid never receives an out-of-range index (the grid ignores it when empty).
  const safeSelectedIndex = entryCount === 0 ? 0 : Math.min(selectedIndex, entryCount - 1);
  const activeTileId = entryCount > 0 ? `fredo-launcher-tile-${safeSelectedIndex}` : undefined;

  // AC5: when a feature window opens through ANY path (launcher tile, self-open,
  // Konami, setup wizard), sink the ENGAGED grid so the freshly opened window is
  // not obscured — but DO NOT unmount the resting surface. The surface is always
  // mounted at the shell root and is simply re-z'd below the window stack
  // (`surfaceZ`), so the search/command access never disappears on window close.
  useEffect(() => {
    const prev = prevWindowCountRef.current;
    prevWindowCountRef.current = currentWindows.length;
    if (currentWindows.length > prev) {
      // #2823: a window opening (via ANY path) closes the shortcut overlay too, so
      // the freshly opened window is never obscured by a raised launcher surface.
      closeSurface();
      // Move focus out of the (now window-covered) launcher surface so keystrokes
      // are routed to the freshly opened window rather than the hidden search
      // input behind it (AC5 — the surface stays mounted, but is below the window).
      if (overlayRef.current?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    }
  }, [currentWindows, closeSurface]);

  // Keep the keyboard-selected tile scrolled into view within the grid's scroll
  // region — only meaningful while the grid is revealed (engaged).
  useEffect(() => {
    if (!engaged) return;
    const container = overlayRef.current;
    if (!container) return;
    const cells = container.querySelectorAll<HTMLElement>('[role="grid"] [role="gridcell"]');
    cells[safeSelectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [engaged, safeSelectedIndex]);

  // FREDO notch trigger: toggles the grid reveal (idle <-> engaged). The surface
  // itself stays mounted (AC5) — the notch never collapses the search bar.
  const toggleOpen = useCallback(() => {
    setEngaged((e) => !e);
  }, []);

  // Reached-engaged: the command bar received real focus. Programmatic focus
  // (the post-ESC refocus) is suppressed so the grid stays hidden while idle.
  const handleBarFocus = useCallback(() => {
    if (skipNextFocusEngageRef.current) {
      skipNextFocusEngageRef.current = false;
      return;
    }
    setEngaged(true);
  }, []);

  // Leaves-engaged (`:focus-within` guard on the launcher root): collapse to
  // idle ONLY when focus leaves the launcher surface AND the query is empty. A
  // focus hop INTO a grid tile stays inside the surface, so it does not collapse
  // before the tile `onSelect` runs (the tile-click race). A non-empty query
  // keeps the grid engaged so ESC is the only exit.
  const handleSurfaceBlur = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      if (query.trim() !== '') return;
      const root = overlayRef.current;
      const next = e.relatedTarget as Node | null;
      if (root && (!next || !root.contains(next))) {
        // #2823: focus left the surface — collapse the grid AND drop the open overlay
        // back to the resting z-model (no focus-yank; the user moved focus deliberately).
        closeSurface();
      }
    },
    [query, closeSurface],
  );

  // Spec #2882 ST-5 (R-2.5) — the BAR's own focusout is the "input loses focus"
  // trigger: a hold/capture must stop there (before the surface-level collapse
  // logic, which only rewrites the overlay state). The capture stop is idempotent
  // per gesture, so the bubbled surface `onBlur` that follows is a no-op.
  // Spec #2883 ST-2 — the param is `HTMLElement` (not `HTMLInputElement`) so the
  // handler stays valid for BOTH the shipped `Input` and the swapped `Textarea`.
  const handleBarBlur = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      stopCaptureOnBlur();
      handleSurfaceBlur(e);
    },
    [stopCaptureOnBlur, handleSurfaceBlur],
  );

  // `—` MINIMIZE control: collapse the ENGAGED grid back to the resting Main
  // (keep the search bar — AC5) and land focus on the FREDO notch trigger.
  const handleMinimize = useCallback(() => {
    // #2823: minimize closes a shortcut-opened overlay too (its z must drop).
    closeSurface();
    // ST-1r-2 — keep the synchronous mirror in lockstep with the controlled
    // `query`: every synchronous `setQuery` writer updates `barTextRef`, so the
    // pre-session/commit captures can never read the cleared-away text (the
    // stale-mirror phantom-dispatch class).
    barTextRef.current = '';
    setQuery('');
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(NOTCH_SELECTOR)?.focus();
    });
  }, [closeSurface]);

  // #2871 ST-2 — the ONE tile-open path (close overlay → mascot happy beat →
  // full-lifecycle opener). Shared by the filtered selection, a grid click, and
  // the smart-Enter exact-name launch so all three stay behavior-identical.
  const launchFeature = useCallback(
    (feature: FredoFeatureClass) => {
      // #2823: routing a tile through the own-kernel opener closes the overlay so the
      // freshly opened window is never obscured by a raised launcher surface.
      closeSurface();
      // #2854 ST-4: a tile open is the mascot's `happy` trigger (bounded beat).
      triggerDesktopHappy();
      onOpenFeature(feature.id, feature);
    },
    [closeSurface, triggerDesktopHappy, onOpenFeature],
  );

  const openSelected = useCallback(() => {
    const feature = filteredEntries[safeSelectedIndex];
    if (!feature) return;
    launchFeature(feature);
  }, [filteredEntries, safeSelectedIndex, launchFeature]);

  // Spec #2882 ST-4 — the ONE commit path (never a second dispatch route —
  // G-149). It reads ST-1's `resolveEnterAction` — the SAME verdict the hint chip
  // renders — so the promise and the act cannot disagree (R-6.3).
  //
  // Spec #2914 ST-5 — the shell has ONE speech path and no transcript, so bar
  // content is always TYPED (`textOrigin: 'typed'`); the dictated-provenance
  // branch is never produced here.
  //
  // Superseded by this spec (binding contract point 3):
  //   • the `companionBusy` GLOBAL no-op → retired in #2882 ST-4; #2892 ST-5
  //     removes the last busy gate from the resolver, so a TYPED app match always
  //     launches and a typed non-match with an active companion always sends —
  //     even while Fredo is replying (AC5/REQ-2);
  //   • the non-empty non-match `openSelected()` fall-through → retired (R-6.1):
  //     unmatched typed text is sent or left alone, NEVER the substring tile.
  // The EMPTY-query grid selection stays in the Enter handler (R-5.1) — it is not
  // a commit and never reaches here.
  const commitBarQuery = useCallback(
    (raw: string): 'launched' | 'sent' | 'queued' | 'none' => {
      const action = resolveEnterAction({
        query: raw,
        entries: filteredEntries,
        textOrigin: 'typed',
        companionActive,
      });

      if (action.kind === 'launch') {
        launchFeature(action.feature);
        return 'launched';
      }

      if (action.kind === 'send') {
        // `askActiveCompanion` returns a typed `CompanionSendResult` iff this
        // window has an active entity, or `null` otherwise. `rejected` is the ONLY
        // non-accepting outcome; both `dispatched` and `queued` ACCEPT (the bar
        // clears and focus stays). `null`/`rejected` leaves the text UNTOUCHED —
        // never the retired launch fall-through (AC7/REQ-7).
        const result = askActiveCompanion(raw.trim());
        if (result && result.outcome !== 'rejected') {
          setQuery('');
          barTextRef.current = '';
          setEngaged(false);
          return result.outcome === 'queued' ? 'queued' : 'sent';
        }
        return 'none';
      }

      // `none` (empty / no-match-no-companion): the bar keeps its content.
      return 'none';
    },
    [filteredEntries, companionActive, launchFeature],
  );

  const handleSelect = useCallback(
    (index: number) => {
      const feature = filteredEntries[index];
      if (!feature) return;
      launchFeature(feature);
    },
    [filteredEntries, launchFeature],
  );

  const handleQueryChange = useCallback((q: string) => {
    // #2878 ST-1 — synchronous mirror so the release owner's ordinary-space write
    // reads the current text in the same commit (never a one-render-stale read).
    barTextRef.current = q;
    setQuery(q);
    // A fresh filter restarts selection at the first tile.
    setSelectedIndex(0);
    // A present query reveals the grid (engaged) even without surface focus.
    if (q.trim() !== '') setEngaged(true);
  }, []);

  // Spec #2878 ST-1 (R-3.1/R-3.2) — the cancel/discard entry point: restore the
  // pre-session bar text. Called by the Escape branch, the bar's `×` cancel
  // control, and the voice-disabled teardown BEFORE the session is
  // stopped/cancelled. Spec #2914 ST-5 — with no transcript the bar is never
  // capture-written, so this is the shipped discard behaviour (a user edit made
  // during the capture is restored with the rest).
  const restorePreSessionBar = useCallback(() => {
    handleQueryChange(preSessionTextRef.current);
  }, [handleQueryChange]);

  // Spec #2882 ST-4 — keep the mounted-once listener's live-session mirror current.
  useEffect(() => {
    listeningRef.current = voice.listening;
  }, [voice.listening]);

  // Spec #2877 ST-5 (DR-9) — disabling voice while a session is live stops it
  // immediately and releases the microphone (the backend's own `disabled` gate is
  // the belt-and-braces second line). Keyed on the enablement flag only; the live
  // state is read from the ref so this never re-fires per session tick.
  useEffect(() => {
    if (!voiceEnabled && listeningRef.current) {
      // #2878 ST-1 — a voice-disabled teardown is a DISCARD: it restores the
      // pre-session bar text. It still STOPS the session (the #2877 behavior).
      restorePreSessionBar();
      void stopVoice();
    }
  }, [voiceEnabled, stopVoice, restorePreSessionBar]);

  // Spec #2878 ST-1 — the launcher session lifecycle: the gesture mirrors + the
  // pre-session restore target. Primitive deps only (AGENTS.md #523 — never a raw
  // render/identity). Spec #2914 ST-5 — the transcript bookkeeping and the
  // autosend finalize are gone with the transcript path.
  useEffect(() => {
    const now = voice.listening && voice.origin === 'launcher';
    const was = launcherActiveRef.current;
    launcherActiveRef.current = now;
    if (now && !was) {
      // Session start: capture the restore target (R-3.2).
      preSessionTextRef.current = barTextRef.current;
      // Spec #2882 ST-5 — S2 → S3: the pending cue ends the moment the engine is
      // live, and the gesture is now known to have gone live.
      if (holdPendingCueTimerRef.current) {
        clearTimeout(holdPendingCueTimerRef.current);
        holdPendingCueTimerRef.current = null;
      }
      setHoldPending(false);
      blurStopIssuedRef.current = false;
      if (holdArmedRef.current) holdWentLiveRef.current = true;
      // Spec #2882 ST-5 (R-2.6) — the STALE-HOLD GUARD: the release landed BEFORE
      // the engine confirmed the start, so this late session is CANCELLED on its
      // rise edge (a no-op `stt_cancel` would leave the microphone hot — the
      // privacy violation). The one ordinary space the release already wrote is
      // PRESERVED: the cancel never touches the bar.
      if (cancelOnLiveRef.current) {
        cancelOnLiveRef.current = false;
        void cancelVoice();
      }
    }
  }, [voice.listening, voice.origin, cancelVoice]);

  // ── Spec #2897 ST-6 (REQ-5 end-to-end) — the model-audio delivery glue ──────
  // Nothing wired ST-2's clip command, ST-3's transport and ST-4's `processing`
  // state together; this is that ONE seam. When the backend commits a model-audio
  // clip (`voice.modelAudioPhase === 'processing'`), the shell takes the clip and
  // dispatches it as the turn's input — the model's reply then flows through the
  // normal conversation (`llm-token`/`llm-done` → `CompanionEntity`).
  //
  // EXACTLY ONCE per session: the guard is a phase-derived ref. A `capturing`
  // phase re-arms it for the NEXT session, and a `dispatched` marker makes a
  // re-render (or any other effect re-run) a no-op — never a bare
  // effect-on-every-render (AGENTS.md re-render-loop rules). No transcript is
  // ever written here, and on a null clip / dispatch failure the typed fallback
  // copy is surfaced through the shipped below-bar alert.
  const [modelAudioFailure, setModelAudioFailure] = useState<ModelAudioFailureCode | null>(null);
  const modelAudioDispatchRef = useRef<'idle' | 'dispatched'>('idle');

  const dispatchModelAudioTurn = useCallback(async () => {
    let taken: SttAudioClipResult | undefined;
    try {
      taken = await adapterBridge.invoke<SttAudioClipResult>('stt_take_audio_clip');
    } catch {
      setModelAudioFailure(MODEL_AUDIO_GENERIC_FAILURE);
      return;
    }
    const clip = taken?.clip ?? null;
    if (!clip || typeof clip.base64 !== 'string' || clip.base64.length === 0) {
      // A null clip is a truthful "nothing to deliver" — never a fabricated turn.
      setModelAudioFailure(MODEL_AUDIO_GENERIC_FAILURE);
      return;
    }
    try {
      const outcome = askActiveCompanionWithAudio(clip.base64);
      if (!outcome || outcome.outcome === 'rejected') {
        // No active companion can receive the turn / it was rejected (REQ-7).
        setModelAudioFailure(MODEL_AUDIO_GENERIC_FAILURE);
      }
    } catch {
      setModelAudioFailure(MODEL_AUDIO_GENERIC_FAILURE);
    }
  }, []);

  useEffect(() => {
    if (voice.modelAudioPhase === 'capturing') {
      // A NEW capture began: re-arm the once-per-session guard and clear the
      // previous turn's failure.
      modelAudioDispatchRef.current = 'idle';
      setModelAudioFailure(null);
      return;
    }
    if (voice.modelAudioPhase !== 'processing') return;
    if (modelAudioDispatchRef.current === 'dispatched') return;
    modelAudioDispatchRef.current = 'dispatched';
    void dispatchModelAudioTurn();
  }, [voice.modelAudioPhase, dispatchModelAudioTurn]);

  // ── Spec #2897 round 2 (R2-1, F-104) — the model-audio TURN-COMPLETION overlay ─
  // The STT plane is silent after the stop commits `processing` (`session.rs`
  // `finish_phase` emits the terminal `phase:"processing"` and then the voice
  // session is over), so `voice.modelAudioPhase` would stay `'processing'` until
  // the NEXT session. The completion signal already exists in the shell:
  // `replyInFlight` (the audio generation's start → `llm-done`, cleared by
  // `CompanionEntity`). This derives `modelAudioTurnSettled` from it — latching on
  // the rise and settling on the fall — so the DERIVED phase returns to `'idle'`
  // (`stopped`) without mutating the raw backend-owned phase. That keeps the
  // exactly-once dispatch guard + the ST-4 announcements keyed on the RAW phase
  // intact. Primitive deps only, and state is written ONLY on a real transition
  // (AGENTS.md #523 — no write per render, no object/array dep).
  const [modelAudioTurnSettled, setModelAudioTurnSettled] = useState(false);
  const modelAudioReplyStartedRef = useRef(false);
  useEffect(() => {
    if (voice.modelAudioPhase !== 'processing') {
      // A new `capturing` session or a cancel's `phase:null` re-arms: the next
      // session is never pre-settled.
      modelAudioReplyStartedRef.current = false;
      setModelAudioTurnSettled(false);
      return;
    }
    if (modelAudioFailure !== null) {
      // A dispatch that never yielded an accepted generation (null clip /
      // rejected / no companion) is surfaced by the ST-6 alert; settle so no
      // `processing` overlay lingers beneath it.
      setModelAudioTurnSettled(true);
      return;
    }
    if (replyInFlight) {
      // The dispatched audio generation is streaming — latch its rise.
      modelAudioReplyStartedRef.current = true;
      return;
    }
    if (modelAudioReplyStartedRef.current) {
      // `llm-done` (or the `llm-error` / watchdog settle) — the turn completed.
      setModelAudioTurnSettled(true);
    }
  }, [voice.modelAudioPhase, replyInFlight, modelAudioFailure]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // Spec #2882 ST-5 — a HOLD gesture in flight is disarmed FIRST: its
        // trailing keyup writes NO space and issues no stop, and a session that
        // goes live after this Escape is cancelled on its rise edge (the mic-hot
        // race). The utterance is discarded (a cancel), never kept — that is the
        // bound resolution: only Escape / the visible `×` discard.
        if (holdArmedRef.current || thresholdCrossedRef.current) {
          const mayStart = thresholdCrossedRef.current && !listeningRef.current;
          holdDisarmedRef.current = true;
          blurStopIssuedRef.current = true;
          resetHoldGesture();
          if (mayStart) cancelOnLiveRef.current = true;
          // A session that raced in before/at the Escape still takes the existing
          // cancel path (restore the draft).
          if (listeningRef.current) {
            restorePreSessionBar();
            // S4 — a genuinely live discard announces `Dictation cancelled`.
            signalCancel();
          }
          void cancelVoice();
          return;
        }
        // Spec #2877 ST-5 ((g).2, binding) — a live dictation session cancels
        // FIRST (the launcher stays open, the text is kept); otherwise Escape
        // keeps today's exact behavior (shortcut-open → closeOverlay with
        // focus-origin restore; non-shortcut → idle collapse).
        // #2878 ST-1 — restore the pre-session text before `cancel()` (R-3.2).
        if (listeningRef.current) {
          restorePreSessionBar();
          // S4 — Escape while live: announce `Dictation cancelled`, never the
          // S3 `Stopped listening` (UI/UX §4).
          signalCancel();
          void cancelVoice();
          return;
        }
        if (open) {
          // #2823: ESC on a shortcut-opened overlay closes the overlay (AC2) and
          // restores focus to the pre-open element (REQ-5). This is the ONLY action
          // — it does NOT co-fire the old idle-collapse branch (AC4).
          closeOverlay();
          return;
        }
        // #2819: ESC (mouse/idle, not shortcut-opened) returns to IDLE (grid +
        // hints hide), the surface stays. This pre-existing behavior is untouched.
        setEngaged(false);
        // Restore focus to the command-bar searchbox (idle affordance) WITHOUT
        // re-engaging — the programmatic refocus is suppressed so the grid stays
        // hidden until the user actually focuses/types again.
        window.requestAnimationFrame(() => {
          // Spec #2883 ST-2 — tag-agnostic: `.value` + `.setSelectionRange`
          // exist on both the shipped `Input` and the swapped `Textarea`, so
          // ESC's refocus is unaffected by the element swap.
          const input = overlayRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            SEARCHBOX_SELECTOR,
          );
          if (input && document.activeElement !== input) {
            skipNextFocusEngageRef.current = true;
            input.focus();
          }
        });
        return;
      }

      // Spec #2883 ST-2 — tag-agnostic: a `Textarea` field must be recognised as
      // "from the text field" too, or Space would fall through to the tile-open
      // branch while the user is typing a query.
      const isFromInput = isBarFieldTag(e.target as HTMLElement);

      // Spec #2882 ST-4 — smart Enter, evaluated BEFORE the empty-grid guard so a
      // chat send still works when the query filters every tile out. Escape stays
      // first; arrows/Space keep the empty-grid no-op below. The commit rule lives
      // in ST-1's `resolveEnterAction` (the SAME verdict the chip renders):
      //   empty query          → today's launch of the selected tile (never a send);
      //   live capture         → NOTHING (ST-5-fix QA-10 — no launch, no send, no
      //                          mutation of the bar: the capture is provisional);
      //   typed + app match    → open it, INDEPENDENT of the companion / busy (AC5);
      //   typed, no match      → send when an active companion accepts, else nothing
      //                          (R-6.1 — the retired `openSelected()` fall-through).
      // Spec #2883 ST-2 (R-1.4) — `Shift+Enter` inserts a newline through the
      // browser's NATIVE insertion: return BEFORE the Enter branch and WITHOUT
      // `preventDefault`, so the field edits itself and its `onChange` carries the
      // newline through the ONE `handleQueryChange` route (no manual splice, no
      // caret restore). It is evaluated BEFORE the Enter branch so `Enter`'s
      // shipped #2882 action is untouched (R-1.5); it starts ZERO generations and
      // opens ZERO windows — a newline can never be a launch or a send.
      if (e.key === 'Enter' && e.shiftKey) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        // Spec #2882 ST-5-fix (QA-10, R-6.3) — the Enter verdict comes from the SAME
        // pure `resolveEnterAction` the hint chip renders, fed the SAME `captureLive`
        // primitive. WHILE a launcher-origin capture is live the verdict is
        // `none/listening` in EVERY query state, so Enter can never open a partially
        // transcribed live text or dispatch a partial — and the chip, derived from
        // the identical verdict, can only read `release Space to finish` (or the
        // busy copy, which outranks it). Both are no-ops, so the pair always agrees.
        const verdict = resolveEnterAction({
          query,
          entries: filteredEntries,
          textOrigin: 'typed',
          companionActive,
          captureLive,
        });
        if (verdict.kind === 'none' && verdict.reason === 'listening') return;

        const q = query.trim();
        // The empty branch keeps today's grid launch — it must never be reachable
        // from the autosend path (R-5.1). A reply GENERATION in flight keeps the
        // empty-query grid launch a no-op (`replyInFlight`, NOT the read-hold
        // `isInUse`, #2892 ST-5); a TYPED app match below still launches while
        // replying (AC5).
        if (q === '') {
          if (companionReplying) return;
          openSelected();
          return;
        }
        // #2878 ST-1 — the ONE commit path (one dispatch route — G-149). Spec
        // #2914 ST-5 — bar content is always typed (there is no dictation).
        commitBarQuery(q);
        return;
      }

      // ── Spec #2882 ST-5 — hold-Space dictates (R-2.1/R-2.2/R-3.1-3.3) ────────
      // Evaluated BEFORE the empty-grid guard: the target is the searchbox input,
      // so a fully-filtered grid must never block the gesture. The verdict is
      // ST-2's PURE precedence — a Space may only be consumed under the FULL R-2.1
      // precondition (focused empty bar + voice usable + unmodified + non-repeat),
      // and every other input stays natively ordinary (R-3.1-3.3: no promise, no
      // capture attempt, no error).
      if (e.key === ' ') {
        // A disarmed gesture (Escape / the visible `×` / a blur stop) swallows
        // every Space keydown — auto-repeats included — until the release, so a
        // discarded hold can never leak a run of spaces.
        if (holdDisarmedRef.current) {
          e.preventDefault();
          return;
        }
        const spaceTarget = e.target as HTMLElement;
        const spaceVerdict = resolveSpaceKeyDown({
          holdArmed: holdArmedRef.current,
          // The SEARCHBOX specifically — a tile-focused Space keeps its existing
          // opens-the-tile meaning (the switch below), and hold-Space never
          // applies to any other Fredo text input (REQ-14). Spec #2883 ST-2: the
          // predicate is tag-agnostic (INPUT or TEXTAREA) with `role="searchbox"`
          // still the anchor, so the swap to a `Textarea` changes nothing here.
          isBarInputTarget:
            isBarFieldTag(spaceTarget) && spaceTarget.getAttribute('role') === 'searchbox',
          queryIsEmpty: query === '',
          // Spec #2914 ST-5 (R-3) — the persisted enablement is the WHOLE arming
          // gate. The deleted sherpa readiness probe no longer withholds the
          // gesture; the backend capability gate owns start-time degradation.
          voiceUsable: voiceEnabled,
          // #2892 ST-5 — the hold precondition uses the SAME `replyInFlight`
          // primitive as `holdAvailable` (the promise placeholder), so the offer
          // and the actual arm can never disagree.
          busy: companionReplying,
          modified: e.ctrlKey || e.metaKey || e.altKey || e.shiftKey,
          repeat: e.repeat,
        });
        if (spaceVerdict === 'hold-arm') {
          // R-2.1 — consume the keydown so no space reaches the input, and start
          // the bounded hold timer.
          e.preventDefault();
          armHold();
          return;
        }
        if (spaceVerdict === 'hold-suppress') {
          // R-2.2 — WHILE armed every Space keydown is swallowed (incl. the OS
          // auto-repeat): no restart, no run of spaces.
          e.preventDefault();
          return;
        }
        // `ordinary-space` — nothing promised: fall through to the native
        // character, and to the grid's tile-open branch when a TILE has focus.
      }

      // AC4: an empty / fully-filtered grid has no openable target — arrows and
      // Space are NO-OPs (keyboard never opens a tile that does not exist).
      if (entryCount === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i + columns, entryCount));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i - columns, entryCount));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i + 1, entryCount));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setSelectedIndex((i) => clampIndex(i - 1, entryCount));
          break;
        // Enter is handled ABOVE (before the empty-grid guard) — smart-Enter.
        case ' ':
          // Space opens only when a tile is focused (not while typing a query), AND
          // only when unmodified. Ctrl+Space is the global launcher toggle (handled by
          // the document listener) — a modified Space must NEVER be a plain-Space
          // tile-open (AC4: the chord triggers only the launcher toggle).
          if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isFromInput) {
            e.preventDefault();
            openSelected();
          }
          break;
      }
    },
    [
      columns,
      entryCount,
      openSelected,
      commitBarQuery,
      companionReplying,
      companionActive,
      captureLive,
      filteredEntries,
      query,
      open,
      closeOverlay,
      cancelVoice,
      restorePreSessionBar,
      armHold,
      resetHoldGesture,
      signalCancel,
      voiceEnabled,
    ],
  );

  // #2823: the global Ctrl+Space shortcut — a bubble-phase `document` keydown
  // listener (the `useKonamiCode.ts:55-60` precedent) that works from anywhere
  // inside the Fredo window (no OS/Tauri global-shortcut plugin). It:
  //   - matches EXACTLY Ctrl+Space (physical `code === 'Space'`, no meta/alt/shift)
  //     so it is a distinct chord from plain Space (AC4 / NFR-5);
  //   - is a NO-OP while typing in a text-control OUTSIDE the launcher surface
  //     (AC3/#2823 carve-out), treating the launcher's own searchbox as a valid
  //     target (NFR-7);
  //   - only `preventDefault()` + `stopPropagation()` when it actually acts so the
  //     chord NEVER reaches a second action (AC4);
  //   - Spec #2882 ST-4 — has ONE meaning: show/focus the bar (R-1.1/R-1.2/R-1.3).
  //     The shipped listening cascade is retired: no branch starts, stops or
  //     cancels a dictation session, and the chord NEVER closes the bar.
  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!(e.ctrlKey === true && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Space')) {
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const activeInLauncher = !!active && !!overlayRef.current && overlayRef.current.contains(active);
      const action = selectCtrlSpaceAction({
        activeIsTextControl: isTextControl(active),
        activeInLauncher,
      });

      // #2823 AC3/AC4: a pass neither acts nor swallows the chord.
      if (action === 'pass') return;
      e.preventDefault();
      e.stopPropagation();

      // `open` — raise the surface, focus the bar and place the caret (R-1.1).
      openOverlay();
    },
    [openOverlay],
  );

  // Spec #2882 ST-5 — the SINGLE release owner for the hold gesture (R-2.2/R-2.6/
  // R-2.7, UI/UX §5.9): one mount-once bubble-phase `document` keyup listener,
  // inert outside a hold. It is on `document` (not the bar) because a release must
  // be honoured even when focus/pointer moved mid-hold. The gesture's timers are
  // cleared exactly once here (and in the disarm/blur paths).
  //
  // The verdict comes from ST-2's pure `resolveSpaceKeyUp`; this handler performs
  // the DOM/timer/mic side of it and writes AT MOST ONE ordinary space through the
  // ordinary typed path (never a second write route).
  const handleGlobalKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;

      // A disarmed gesture (Escape / the visible `×` / a blur stop) swallows its
      // trailing release: no space, no stop — the capture was already dealt with.
      if (holdDisarmedRef.current) {
        holdDisarmedRef.current = false;
        resetHoldGesture();
        return;
      }
      if (!holdArmedRef.current) return;

      const verdict = resolveSpaceKeyUp({
        holdArmed: holdArmedRef.current,
        // "Went live during THIS gesture": a live-then-stopped capture finalizes;
        // only a gesture that NEVER went live writes the fallback space (R-2.6).
        captureLive: launcherActiveRef.current || holdWentLiveRef.current,
        thresholdCrossed: thresholdCrossedRef.current,
      });
      const write = spaceWriteForVerdict(verdict);
      resetHoldGesture();

      if (verdict === 'finalize') {
        // R-2.3 — stop listening. Spec #2914 ST-5 — the model-audio turn is
        // delivered by the backend-owned clip glue on the resulting `processing`
        // phase; the bar is never transcript-written, so NO space is inserted.
        void stopVoice();
        return;
      }
      if (verdict === 'none') return;
      if (verdict === 'cancel-pending') {
        // R-2.6 — the release beat the engine: cancel the session as soon as it
        // reports live so the microphone is never left capturing.
        cancelOnLiveRef.current = true;
      }
      // R-2.6/R-2.7 — exactly ONE ordinary space, through the ordinary query path
      // (never `stt_start`): the tap types the character it always did, and the
      // hold that never captured types one too.
      if (write) handleQueryChange(barTextRef.current + write);
    },
    [handleQueryChange, resetHoldGesture, stopVoice],
  );

  // Spec #2882 ST-5 (R-2.5) — the window-focus safety net: a `window` blur mid-hold
  // loses the keyup, so the capture must be stopped by the blur path (STOP with the
  // autosend commit suppressed, words kept, microphone released).
  const handleWindowBlur = useCallback(() => {
    stopCaptureOnBlur();
  }, [stopCaptureOnBlur]);

  // #2823: mount exactly ONE document listener (NFR-2). A ref-based guard keeps the
  // effect idempotent under React StrictMode; the cleanup removes the listener so it
  // never leaks across an unmount.
  // Spec #2882 ST-5 adds the gesture's single release owner and the window-blur
  // safety net to the same mount-once effect.
  useEffect(() => {
    if (globalKeydownMountedRef.current) return;
    globalKeydownMountedRef.current = true;
    document.addEventListener('keydown', handleGlobalKeyDown);
    document.addEventListener('keyup', handleGlobalKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      globalKeydownMountedRef.current = false;
      document.removeEventListener('keydown', handleGlobalKeyDown);
      document.removeEventListener('keyup', handleGlobalKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [handleGlobalKeyDown, handleGlobalKeyUp, handleWindowBlur]);

  // The gesture's bounded timers must never outlive the surface (AGENTS.md #523 —
  // a single cleared handle per timer, cleared on unmount).
  useEffect(() => () => clearHoldTimers(), [clearHoldTimers]);

  // ── Spec #2883 ST-2 — measure the reply band (R-2.2/R-2.3/R-5.3) ───────────
  // ONE `ResizeObserver` on the launcher column + the command-bar root (the bar
  // grows with the query, which moves `barrierTop`), plus a `scroll` listener on
  // the column (it is the band's clip box) and a window `resize` listener. Every
  // trigger is rAF-coalesced (≤ 1 layout read per frame — never per token or per
  // keystroke), and `setReplyBounds` bails out when no number changed, so this
  // effect can never drive a render loop. `undefined` (before the first
  // measurement, or without a DOM observer) means "no band" ⇒ today's rendering.
  useEffect(() => {
    const column = columnRef.current;
    if (!column || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bar = barRef.current;
      if (!bar) return;
      const columnRect = column.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const gridRect = gridRef.current ? gridRef.current.getBoundingClientRect() : null;
      const next: ReplySurfaceBounds = {
        safeTop: NOTCH_HEIGHT_PX + REPLY_MARGIN,
        // #2886 — the bar's box top AND the app-tiles grid's resting top. The
        // grid sits below the bar, so this is also the tiles' keep-out (E4/E5):
        // the reply's bottom edge can never reach the first tile row.
        barrierTop: gridRect ? Math.min(barRect.top, gridRect.top) : barRect.top,
        boundsLeft: columnRect.left + REPLY_MARGIN,
        boundsRight: columnRect.right - REPLY_MARGIN,
      };
      setReplyBounds((prev) => (prev && replyBoundsEqual(prev, next) ? prev : next));
      // #2886 ST-4 — publish the measured region for the AWAY overlay, which
      // `main.tsx` renders OUTSIDE this shell (a prop cannot reach it). Same rAF
      // pass, so the overlay's placement agrees with the seat's band.
      publishLauncherRegion({
        region: next,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(column);
    if (barRef.current) observer.observe(barRef.current);
    column.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      column.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      publishLauncherRegion(null);
    };
  }, []);

  // ── Spec #2897 ST-6 (REQ-7) — the degradation surface ──────────────────────
  // A failed start / failed delivery surfaces the curated model-audio copy. It
  // is deliberately NOT muted: there is no typed word to lose and REQ-7 requires
  // the user be told. Spec #2914 ST-5 — the inline `Use local transcription`
  // fallback is GONE (there is no local path to switch to), so this is a
  // text-only `role="alert"`.
  const voiceErrorMessage =
    modelAudioFailureCopy(modelAudioFailure) ?? voiceStartErrorCopy(voice.errorCode);

  return (
    <>
      {/* Chrome is always visible: FREDO notch trigger + online clock + the
          decorative desktop frame / side-ticks / dot-grid. It sits ABOVE the
          open surface (zIndex 1200 vs 1100) and is pointerEvents:none except
          the notch, so the surface stays interactive. `engaged` +
          `selectedIndex` drive the engaged-only hint row + the dot-grid accent
          scroll-thumb. Spec #2825: when a non-minimized window covers the
          desktop (`coveredByWindow`), the whole chrome band sinks to z=0 —
          BELOW the z=1 window stack — in lockstep with the surface, so it
          never paints over a feature window or its titlebar controls (R-1/2/3). */}
      <LauncherChrome
        entryCount={entryCount}
        isOnline={isConnected}
        engaged={engaged}
        selectedIndex={safeSelectedIndex}
        onToggle={toggleOpen}
        coveredByWindow={coveredByWindow}
      />

      {/* Resting Main surface (AC5 structural hoist): ALWAYS mounted at the shell
          root so the search/command access NEVER disappears. When a feature
          window covers the desktop (`coveredByWindow`), the whole surface is
          z'd BELOW the window stack so a maximized window is not obscured —
          closing/minimizing the window re-reveals it (it was never unmounted). */}
      <Box
        ref={overlayRef}
        role="dialog"
        aria-label="Fredo launcher"
        position="fixed"
        inset="0"
        zIndex={surfaceZ}
        onKeyDown={handleKeyDown}
        onBlur={handleSurfaceBlur}
        css={surfaceCss}
      >
        <Box
          ref={columnRef}
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="flex-start"
          gap={6}
          height="100%"
          width="100%"
          maxWidth="960px"
          marginX="auto"
          paddingTop="34vh"
          paddingX={8}
          paddingBottom={10}
          overflowY="auto"
          css={{
            '&::-webkit-scrollbar': { width: '8px', height: '8px' },
            '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
          }}
        >
          {/* #2870 ST-3: the seat slot is rendered UNCONDITIONALLY — the wrapper
              owns the exact 80×100 footprint + the `mb="4"` band, so turning the
              companion on/off (or Fredo teleporting away) never changes the
              command bar's geometry. Exactly one of the three states renders
              inside it (see the predicate above). */}
          <Box position="relative" width={AVATAR_SM_CSS.width} height={AVATAR_SM_CSS.height} mb="4">
            {/* OFF: decorative desktop mascot — unchanged markup (no role/tabIndex/
                click; the SVG keeps its own `aria-hidden="true"`), only the
                wrapper-owned `mb="4"` moved up to the seat frame. #2854 ST-4 wires
                only the mascot's INTERNAL expression (`data-state` + avatar
                `state`): thinking/happy/playful/idle — surface-local, never context. */}
            {!companionVisible && (
              <Box className="fredo-avatar-idle" data-state={desktopState}>
                <FredoAvatar size="sm" state={desktopState} />
              </Box>
            )}
            {/* ON + away: the static vacated-seat placeholder (no motion, inert). */}
            {companionAway && <EmptySeat />}
            {/* ON + at home: the interactive companion occupying the seat.
                Spec #2883 ST-2 — the launcher-measured reply band flows
                launcher → entity → bubble so the reply can grow inside the
                window/column band without ever colliding with the bar. */}
            {companionVisible && !companionAway && (
              <CompanionEntity
                surface="seat"
                replyBounds={replyBounds}
                // #2886 round 2 (F3) — lets the shell keep the tiles mounted for
                // the whole reply display (see `companionMessageVisible`).
                onMessageVisibilityChange={handleCompanionMessageVisibility}
              />
            )}
          </Box>
          <LauncherCommandBar
            query={query}
            onQueryChange={handleQueryChange}
            gridOpen={engaged}
            ariaActivedescendant={activeTileId}
            onFocus={handleBarFocus}
            onBlur={handleBarBlur}
            onMinimize={handleMinimize}
            enterMode={commandBar.enterMode}
            hintLabel={commandBar.hintLabel}
            // #2892 ST-5 (AC2/AC3) — the bar's `busy` is a reply GENERATION in
            // flight (`replyInFlight`), never the read-hold `isInUse`.
            busy={companionReplying}
            // #2892 ST-5 (AC5) — the accepted-but-undispatched sends the bar's
            // waiting indicator reflects (0 = none).
            queuedCount={queuedSendCount}
            // Spec #2877 ST-5 (R-5.3) — the bar cue is LAUNCHER-origin only, so
            // exactly one indicator shows per session (companion-origin is the
            // bubble's surface, never the bar). ST-5-fix (QA-10): the SAME
            // `captureLive` primitive the Enter verdict and the hint derive from.
            listening={captureLive}
            // Spec #2887 ST-7 (R-3/AC3) — the ONE derived honest cue replaces the
            // shipped `holdArmed`/`holdPending` pair: `'acknowledge'` at the
            // keydown edge, the bounded `starting voice input…` chip
            // (`'starting'`/launch-window `'warming'`) once the pending window
            // outlives `HOLD_PENDING_CUE_MS`, and `'listening'` ONLY while the
            // capture is genuinely live. One indicator at a time (the bounded chip
            // and the Listening chip share the slot).
            cue={holdCue}
            holdAvailable={holdAvailable}
            // #2878 ST-2 (AC3 resolution) — the Stop control is the FINALIZE/commit
            // control (`stt_stop`), the only autosend trigger; the visible cancel
            // affordance DISCARDS (`stt_cancel`) and never sends. Neither
            // dispatches by itself — only the commit step does.
            onStopListening={() => void stopVoice()}
            onCancelListening={() => {
              holdDisarmedRef.current = true;
              blurStopIssuedRef.current = true;
              resetHoldGesture();
              restorePreSessionBar();
              // S4 — the visible `×` discards a LIVE session: the bar announces
              // `Dictation cancelled` and suppresses `Stopped listening`.
              signalCancel();
              void cancelVoice();
            }}
            // Spec #2887 follow-up (UI/UX §4) — the S4 cancel transition (Escape /
            // `×`) the bar's live region consumes. Bumped only for a live cancel.
            cancelSignal={cancelSignal}
            // Spec #2897 ST-6 (REQ-7) — a failed start / failed delivery surfaces
            // the curated model-audio copy. Spec #2914 ST-5 — the inline
            // `Use local transcription` action is GONE: there is no local path.
            voiceErrorMessage={voiceErrorMessage}
            // Spec #2914 ST-5 (R-4) — ONE speech path. The launcher's mode is the
            // constant `'model'` (never read from `voiceHandling`): the bar renders
            // the model-audio indicator and NEVER feeds the transcript announcer —
            // `voice-transcript-announcer` stays mounted but empty.
            voiceMode="model"
            modelAudioPhase={voice.modelAudioPhase}
            // Spec #2897 round 2 (R2-1, F-104) — the derived turn-completion
            // overlay: once the dispatched audio turn's generation settles the
            // `processing` chip/indicator is removed and the resting placeholder
            // returns (`stopped` → `idle`). The RAW phase above stays
            // backend-owned, so the dispatch guard + ST-4 announcements are
            // untouched.
            modelAudioTurnSettled={modelAudioTurnSettled}
            // Spec #2897 ST-5 (REQ-6) — the pinned ceiling (from the backend
            // `stt:state`) drives the last-N-seconds countdown and the limit
            // notice; `limitReached` is the auto-stop's warning signal.
            modelAudioLimitMs={voice.modelAudioLimitMs}
            limitReached={voice.limitReached}
            voiceEnabled={voiceEnabled}
            ariaLabel={companionActive ? 'Search, launch, or message Fredo' : 'Search or command'}
            ariaDescribedBy="fredo-command-hint"
            // Spec #2883 ST-2 — the band measurement roots: the bar root Box's top
            // edge is the reply's `barrierTop`, and the bar's own resize (it grows
            // with the query) is a band trigger. The bar attaches this ref to its
            // root Box (the contract's `containerRef`).
            containerRef={barRef}
            // Spec #2883 ST-2 (R-1.4) — derived here (the shell owns presence) and
            // passed down; ST-1 renders the caption only on 2+ visual lines.
            newlineHint={companionActive}
          />
          {(engaged || companionMessageVisible) && (
            <LauncherAppGrid
              entries={filteredEntries}
              selectedIndex={safeSelectedIndex}
              onSelect={handleSelect}
              containerRef={gridRef}
            />
          )}
        </Box>
      </Box>
    </>
  );
};
