import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useBreakpointValue } from '@chakra-ui/react';

// Own-kernel window list (Spec #2807 ST-1) — AC1: never the third-party toolbar.
import { useWindows } from '../../../../shared/window-system/useWindows';
// Live stream/connection flag — mirrors StreamStatus.tsx (ONLINE dot).
import { useConnectionStatus } from '../../../../shared/contexts/StreamContext';
// Companion designated presence — gates the launcher mascot (#2853 ST-4).
import { useCompanion } from '../../../../shared/contexts/CompanionContext';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { tint } from '../../../../shared/utils/colorTint';

import { LauncherChrome } from './LauncherChrome';
import { LauncherAppGrid } from './LauncherAppGrid';
import { publishLauncherRegion } from '../../../../shared/components/companion/companionGeometry';
import { LauncherCommandBar } from './LauncherCommandBar';
import type { HoldCue, LauncherEnterMode } from './LauncherCommandBar';
import { EmptySeat } from './EmptySeat';
import { AVATAR_SM_CSS, FredoAvatar, type FredoAvatarState } from '../../../../shared/components/fredo-avatar';
import { CompanionEntity, askActiveCompanion } from '../../../../shared/components/companion';
// Spec #2883 ST-2/ST-3 — the reply band's contract type + margin come from the
// pure reply-layout module (ONE source of truth for the launcher → entity →
// bubble hand-off; the layout maths itself is ST-3/ST-4's).
import {
  REPLY_MARGIN,
  type ReplySurfaceBounds,
} from '../../../../shared/components/companion/replySurfaceLayout';
import { useFredoRestingCadence } from '../../../../shared/hooks/useFredoRestingCadence';
// Spec #2877 ST-5 — live dictation into the existing bar input (the launcher-origin
// listening cue). Spec #2882 ST-4 retires the context-dependent Ctrl+Space cascade.
import { useVoiceDictation } from '../../../../shared/hooks/useVoiceDictation';
// Spec #2882 ST-3 — the fail-closed STT-model readiness probe. Mounted here so the
// shell owns the arming gate (`voiceEnabled && sttModelReady`) ST-5 reads; the
// probe is refreshed on the summon path (Ctrl+Space).
import { useSttModelReady } from '../../../../shared/hooks/useSttModelReady';
// Spec #2887 ST-6/ST-7 — the warm RETRY/re-arm path. The primary warm is the
// backend's setup warm (ST-1 `ResidentEngine::warm_at_setup`); this hook only
// re-attempts the idempotent, engine-only `stt_warm` on the voice-enabled edge,
// the model-ready edge and the summon path. `stt_warm` is single-flight, so a
// retry can never race the setup warm into a second model load.
import { useSttWarm } from '../../../../shared/hooks/useSttWarm';
// Spec #2882 ST-1 — THE ONE pure Enter decision. Both the hint memo and the commit
// path consume it, so the chip can never promise a different action than Enter takes
// (R-6.3). The rule is never re-derived locally.
import {
  enterHintLabel,
  findTopRankedMatch,
  resolveEnterAction,
  type EnterTextOrigin,
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

/** Space-join two bar-text fragments without a duplicate/trailing space (the
 *  same rule `useVoiceDictation` uses, so the bar's live text matches it). */
const joinBarText = (lead: string, tail: string): string => {
  if (!lead) return tail;
  if (!tail) return lead;
  return `${lead} ${tail}`;
};

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
 * Spec #2877 ST-5 (DR-11) — curated, actionable copy for a failed `stt_start`.
 * The typed `SttErrorCode` is the only primary key; a raw IPC detail is never
 * the primary sentence. Non-blocking: the app stays fully usable, no session
 * starts, and the enablement preference is never silently flipped.
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
    case 'internal':
      return 'Voice input hit an unexpected problem. Try again.';
    default:
      return null;
  }
}

/** Subtle dot/tick grid texture (Asset 1.7) — faint border-color color-mix
 *  lines, token-native, behind every window (the overlay is z-gated below the
 *  window stack when covered). */
const DESKTOP_TEXTURE_CSS = {
  backgroundColor: 'var(--card-bg)',
  backgroundImage: [
    `linear-gradient(to right, ${tint('var(--border-color)', 12)} 1px, transparent 1px)`,
    `linear-gradient(to bottom, ${tint('var(--border-color)', 12)} 1px, transparent 1px)`,
  ].join(', '),
  backgroundSize: '28px 28px',
};

export const LauncherShell: React.FC<LauncherShellProps> = ({ showableFeatures, onOpenFeature }) => {
  const currentWindows = useWindows();
  const { isConnected } = useConnectionStatus();
  const { state: companion, voiceEnabled, voiceAutosend } = useCompanion();

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
  // #2871 ST-3 continuous busy primitive (AGENTS.md #523 — primitive read only).
  const companionBusy = companion.isInUse;

  // Spec #2882 ST-4 — Ctrl+Space shows/focuses the bar (see `selectCtrlSpaceAction`);
  // the launcher-origin listening cue (DR-7) is unchanged. `start`/`stop`/`cancel`
  // are stable useCallbacks, so the document listener below keeps a stable identity
  // and is mounted exactly once (NFR-2).
  const voice = useVoiceDictation();
  // Spec #2882 ST-5 — CT-1: the hold gesture is now the ONLY launcher capture
  // entry point (ST-4 retired every Ctrl+Space listening branch, ST-6 retired the
  // companion-origin path), so `start` is wired to the hold timer's arm path.
  const { start: startVoice, stop: stopVoice, cancel: cancelVoice } = voice;
  // Spec #2882 ST-3 — the fail-closed model-readiness probe (R-3.3). Mounted here so
  // the shell owns the arming gate ST-5 reads (`voiceEnabled && sttModelReady`);
  // refreshed on the summon path. It probes ONLY while voice is enabled.
  const sttModel = useSttModelReady(voiceEnabled);
  // Spec #2887 ST-7 (R-1/R-4/R-6/R-7) — mount the warm retry/re-arm path. The
  // backend setup warm is the PRIMARY trigger (never a second model load: the
  // backend's `stt_warm` single-flight is authoritative); this only re-attempts
  // it, so a missed or lost warm recovers. Residency is surfaced separately
  // through `voice.engineResident` (ST-3's `stt:state` stamp) for the cue.
  const sttWarm = useSttWarm(voiceEnabled, sttModel.ready);
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
  // All are mutable refs (never state) so they can be read/written synchronously
  // inside effects in the SAME commit (a one-render-stale `query` read would
  // commit the previous utterance's text). Deps stay primitives (AGENTS.md #523).
  //
  // `barTextRef` mirrors the controlled bar query synchronously — the live-text
  // effect and the finalize effect both run in one commit, so the commit reads
  // the text the live-text effect just wrote.
  const barTextRef = useRef('');
  // R-3.2 restore target (the bar text present BEFORE the session started).
  const preSessionTextRef = useRef('');
  // The hook accumulates `committed` across sessions, so each utterance writes
  // only its own segments (`committed` minus the baseline captured at start).
  const sessionBaseCommittedRef = useRef('');
  const prevCommittedRef = useRef('');
  // UX-2 — after the first manual keystroke during a live segment, partial
  // writes stop for the session (finals still append). Reset at session start.
  const userEditedDuringSessionRef = useRef(false);
  // R-3.1 — a cancel suppresses the autosend commit and restores the pre-session
  // text. Reset at session start.
  const cancelledRef = useRef(false);
  // The exactly-once witness (R-2.5/4.2) plus the finalize bookkeeping that
  // survives a final transcript landing just after the `listening:false` event.
  const autosendFiredRef = useRef(false);
  const launcherActiveRef = useRef(false);
  const finalizePendingRef = useRef(false);
  // ST-1r — the no-produced finalize restores the pre-session bar text ONCE per
  // session; the finalize effect then STAYS armed for a late final, so the
  // once-guard is what stops a later manual keystroke being clobbered by a
  // repeated restore. Reset at session start with the other per-session guards.
  const restoredAfterSessionRef = useRef(false);
  // Spec #2882 ST-4 (R-4.3, clarification #2) — the bar's content PROVENANCE.
  // TRUE iff the bar's text originated from a launcher-origin dictation capture
  // that produced a committed final. It is NEVER inferred from the text and NEVER
  // cleared by a user edit; it clears only when the content stops existing (bar
  // emptied, committed, minimized, or suppress-restored). This ref is the
  // synchronous mirror the commit path reads — `commitBarQuery` may run in the
  // same commit in which the finalize wrote the bar.
  const dictationOriginRef = useRef(false);

  // #2819 FIXED: the shell surface is visible by default at launch (idle), so a
  // fresh launch shows the avatar + command bar instead of a blank desktop.
  // Grid + keyboard-hints sub-state: reached when the command bar is focused or a
  // query is present; returns to idle on ESC / focus-leaving-the-surface (empty query).
  const [engaged, setEngaged] = useState(false);
  const [query, setQuery] = useState('');
  // Spec #2882 ST-4 (R-4.3/R-4.5) — render-time provenance, so the hint memo can
  // derive the truthful chip (`↵ send transcript to Fredo`) for dictated content.
  // The ref above is the synchronous mirror the commit path reads.
  const [dictationOrigin, setDictationOrigin] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // #2823: shortcut-opened overlay state — DISTINCT from the #2819 `engaged`
  // grid-reveal. `open` is TRUE only when the launcher was summoned by Ctrl+Space
  // (it re-z's above the window stack + autofocuses the searchbox). When FALSE the
  // resting z-model (coveredByWindow) applies unchanged.
  const [open, setOpen] = useState(false);

  // ── Spec #2882 ST-5 — the hold-to-dictate gesture state (never persisted) ────
  // The WHILE-Space-is-held condition is a continuous state machine, not a set of
  // transition call-sites: `holdArmed` is the cue from the keydown moment for the
  // WHOLE gesture (R-2.4), `holdPending` is the bounded `starting voice input…`
  // chip once the engine start outlives `HOLD_PENDING_CUE_MS` (S2). One release
  // owner: the mount-once document keyup listener below (inert outside a hold).
  const [holdArmed, setHoldArmed] = useState(false);
  const [holdPending, setHoldPending] = useState(false);
  // R-2.1 / contract 4c — the promise placeholder is offered only when the whole
  // precondition is available (voice on + FAIL-CLOSED model readiness + not busy).
  // Readiness unknown ⇒ no promise is made and Space stays natively ordinary.
  const holdAvailable = voiceEnabled && sttModel.ready && !companionBusy;
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
  // R-2.5.6 (AC3) — a hold-origin start failure is SILENT (no alert, no error
  // text). Muted from the moment the hold starts the engine and re-armed when the
  // next gesture arms, so a failure arriving with NO hold start in flight (the
  // app-global `stt:state` channel — the DR-11 lever) still surfaces the copy.
  const [holdFailureMuted, setHoldFailureMuted] = useState(false);
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
  // R-2.5 — a blur stop keeps the words but must never trigger the autosend commit.
  const suppressAutosendOnceRef = useRef(false);
  // R-2.5 — one blur stop per gesture (the input's focusout and a `window` blur
  // can both report the same gesture).
  const blurStopIssuedRef = useRef(false);
  // Spec #2887 ST-7 (R-5e) — the session-scoped provenance of the END-of-session
  // finalize. `holdSessionRef` records that THIS session rose from an armed hold
  // (the threshold-crossed gesture — the only launcher capture entry point), and
  // `releaseFinalizeRef` records that the session ended by the user's RELEASE
  // (the finalize gesture) rather than a blur or a cancel. Together they let the
  // no-produced-final branch tell a word-less HOLD apart from a programmatic /
  // silent session: only the former lands the one ordinary space. Both are
  // re-assigned at every session start, so they can never leak across sessions.
  const holdSessionRef = useRef(false);
  const releaseFinalizeRef = useRef(false);

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
      // From here any failure belongs to this hold-origin start: silent (AC3).
      setHoldFailureMuted(true);
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
  // discard: the capture stops, the microphone is released, the recognized words
  // are KEPT in the bar as a dictated transcript, and the autosend commit is
  // SUPPRESSED (a release is the send consent; a blur is not). Discard + restore
  // applies ONLY to an explicit cancel (Escape / the visible `×`).
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
      suppressAutosendOnceRef.current = true;
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

  // Spec #2882 ST-4 — the ONE provenance writer. The ref is assigned synchronously
  // so a commit path running in the SAME commit as the write reads the new value.
  const setBarOrigin = useCallback((dictated: boolean) => {
    dictationOriginRef.current = dictated;
    setDictationOrigin(dictated);
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
    // ST-3 contract — the summon path re-probes model readiness (bounded,
    // coalesced, and a no-op while voice is disabled).
    sttModel.refresh();
    // Spec #2887 ST-7 (ST-6 contract) — and re-arms the engine residency on the
    // same summon edge. Idempotent + single-flight + no-op while disabled or
    // not-ready + silent on failure: it can never block or duplicate the load.
    sttWarm.warmNow();
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
  }, [sttModel.refresh, sttWarm.warmNow]);

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
      textOrigin: dictationOrigin ? 'dictated' : 'typed',
      companionActive,
      companionBusy,
      captureLive,
    });
    const hintLabel = enterHintLabel(action, { busy: companionBusy, queryEmpty });
    const enterMode: LauncherEnterMode =
      action.kind === 'launch' ? 'launch' : action.kind === 'send' ? 'send' : 'none';
    return { enterMode, hintLabel };
  }, [
    query,
    filteredEntries,
    dictationOrigin,
    companionActive,
    companionBusy,
    captureLive,
  ]);

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
    // Spec #2882 ST-4 — minimize clears the bar, so the content provenance is
    // reset with it (declared data contract).
    setBarOrigin(false);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(NOTCH_SELECTOR)?.focus();
    });
  }, [closeSurface, setBarOrigin]);

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

  // Spec #2882 ST-4 — the ONE commit path, shared by the Enter handler and the
  // autosend finalize effect (never a second dispatch route — G-149). It reads
  // ST-1's `resolveEnterAction` — the SAME verdict the hint chip renders — so the
  // promise and the act cannot disagree (R-6.3). The caller supplies the content
  // PROVENANCE (`origin`), which decides whether a launch is even possible.
  //
  // Superseded by this spec (binding contract point 3):
  //   • the `companionBusy` GLOBAL no-op → busy now affects only the SEND path: a
  //     TYPED app match launches even while Fredo is replying (AC5);
  //   • the non-empty non-match `openSelected()` fall-through → retired (R-6.1):
  //     unmatched typed text is sent or left alone, NEVER the substring tile;
  //   • "a dictated exact tile name launches" (#2878) → retired (R-4.3): dictated
  //     content is delivered or left alone, NEVER an app.
  // The EMPTY-query grid selection stays in the Enter handler (R-5.1) — it is not
  // a commit and never reaches here.
  const commitBarQuery = useCallback(
    (raw: string, origin: EnterTextOrigin): 'launched' | 'sent' | 'none' => {
      const action = resolveEnterAction({
        query: raw,
        entries: filteredEntries,
        textOrigin: origin,
        companionActive,
        companionBusy,
      });

      if (action.kind === 'launch') {
        launchFeature(action.feature);
        return 'launched';
      }

      if (action.kind === 'send') {
        // `askActiveCompanion` returns true iff this window has an active entity
        // that accepted the message. A `false` (no active entity) leaves the text
        // UNTOUCHED — never the retired launch fall-through.
        if (askActiveCompanion(raw.trim())) {
          setQuery('');
          barTextRef.current = '';
          setBarOrigin(false);
          setEngaged(false);
          return 'sent';
        }
        return 'none';
      }

      // `none` (empty / busy / no-match-no-companion): the bar keeps its content.
      return 'none';
    },
    [
      filteredEntries,
      companionActive,
      companionBusy,
      launchFeature,
      setBarOrigin,
    ],
  );

  const handleSelect = useCallback(
    (index: number) => {
      const feature = filteredEntries[index];
      if (!feature) return;
      launchFeature(feature);
    },
    [filteredEntries, launchFeature],
  );

  const handleQueryChange = useCallback(
    (q: string) => {
      // #2878 ST-1 — synchronous mirror so the finalize commit reads the text the
      // live-text effect wrote in this same commit (never a one-render-stale read).
      barTextRef.current = q;
      setQuery(q);
      // A fresh filter restarts selection at the first tile.
      setSelectedIndex(0);
      // A present query reveals the grid (engaged) even without surface focus.
      if (q.trim() !== '') setEngaged(true);
      // Spec #2882 ST-4 (clarification #2) — the content stopped existing, so its
      // provenance does too. A USER EDIT is not a reset (the text is still the
      // dictated transcript); only a genuine emptying is.
      if (q === '') setBarOrigin(false);
    },
    [setBarOrigin],
  );

  // Spec #2878 ST-1 (R-3.1/R-3.2) — the cancel/discard entry point: suppress the
  // autosend commit for the ended session and restore the pre-session bar text.
  // Called by the Escape branch, the bar's `×` cancel control, and the
  // voice-disabled teardown BEFORE the session is stopped/cancelled. #2882 ST-4:
  // a discard also resets the content PROVENANCE (declared data contract).
  const suppressAutosendAndRestore = useCallback(() => {
    cancelledRef.current = true;
    setBarOrigin(false);
    handleQueryChange(preSessionTextRef.current);
  }, [handleQueryChange, setBarOrigin]);

  // Spec #2882 ST-4 — keep the mounted-once listener's live-session mirror current.
  useEffect(() => {
    listeningRef.current = voice.listening;
  }, [voice.listening]);

  // Spec #2882 ST-5 (R-2.5.6/AC3) — the failure mute lives exactly as long as the
  // error it belongs to: it clears when the hook's error clears OUTSIDE a gesture
  // (a new session / a successful start), so the NEXT start's failure can be muted
  // again while a stale hold-origin error is never surfaced later. While a gesture
  // is in flight the mute survives the start's optimistic error-clear.
  useEffect(() => {
    if (voice.errorCode === null && !holdArmedRef.current) setHoldFailureMuted(false);
  }, [voice.errorCode]);

  // Spec #2877 ST-5 (DR-9) — disabling voice while a session is live stops it
  // immediately and releases the microphone (the backend's own `disabled` gate is
  // the belt-and-braces second line). Keyed on the enablement flag only; the live
  // state is read from the ref so this never re-fires per session tick.
  useEffect(() => {
    if (!voiceEnabled && listeningRef.current) {
      // #2878 ST-1 — a voice-disabled teardown is a CANCEL: it suppresses the
      // autosend commit and restores the pre-session bar text (R-3.1/R-3.2). It
      // still STOPS the session (the #2877 behavior) and never autosends.
      suppressAutosendAndRestore();
      void stopVoice();
    }
  }, [voiceEnabled, stopVoice, suppressAutosendAndRestore]);

  // Spec #2878 ST-1 — the launcher session lifecycle: the exactly-once guard's
  // key (R-2.5/4.2). Declared BEFORE the live-text effect so the pre-session text
  // and the committed baseline are captured before the transcript writer clears
  // the bar. Primitive deps only (AGENTS.md #523 — never a raw render/identity).
  useEffect(() => {
    const now = voice.listening && voice.origin === 'launcher';
    const was = launcherActiveRef.current;
    launcherActiveRef.current = now;
    if (now && !was) {
      // Session start: reset every per-session guard and capture the restore
      // target (R-3.2) + the committed baseline (the hook accumulates
      // `committed` across sessions, so each utterance prints only its own text).
      autosendFiredRef.current = false;
      cancelledRef.current = false;
      userEditedDuringSessionRef.current = false;
      finalizePendingRef.current = false;
      restoredAfterSessionRef.current = false;
      // R-2.5 — a blur suppression is one-shot per session; a fresh session must
      // never inherit a stale mute.
      suppressAutosendOnceRef.current = false;
      // R-5e — capture THIS session's provenance before the gesture refs are
      // cleared by the release (the arm flag is still set while the capture is
      // live; the release clears it in the same tick as the stop).
      holdSessionRef.current = holdArmedRef.current;
      releaseFinalizeRef.current = false;
      preSessionTextRef.current = barTextRef.current;
      sessionBaseCommittedRef.current = voice.committed;
      prevCommittedRef.current = voice.committed;
      // Spec #2882 ST-5 — S2 → S3: the pending cue ends the moment the engine is
      // live, and the gesture is now known to have gone live (so its release is a
      // FINALIZE even if the session ends first).
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
      // privacy violation). The utterance is discarded (the hold never captured)
      // and the one ordinary space the release already wrote is PRESERVED: the
      // cancel suppresses the autosend commit AND the no-final restore.
      if (cancelOnLiveRef.current) {
        cancelOnLiveRef.current = false;
        cancelledRef.current = true;
        void cancelVoice();
      }
    } else if (was && !now) {
      // Session end: arm the finalize commit. The commit effect below also runs
      // on `voice.liveText` so a final transcript landing just after the
      // `listening:false` state event still commits (the exactly-once witness
      // lives in `autosendFiredRef`). ST-1r — the commit EVIDENCE is derived in
      // the finalize effect from the session-scoped `committed` delta, never
      // from the bar mirror.
      finalizePendingRef.current = true;
    }
  }, [voice.listening, voice.origin, voice.committed, cancelVoice]);

  // Spec #2877 ST-5 / #2878 ST-1+ST-2 — live transcript → the EXISTING controlled
  // bar input, LAUNCHER-origin sessions only. Writes the session-scoped
  // `committed + partial` through the one `handleQueryChange` path (never a second
  // input, never a submit, never grid navigation); a companion-origin session
  // never writes into the bar. Two #2878 guards:
  //   • R-3.1 — a cancelled session's late transcript never re-writes the bar
  //     (the restore wins until the next session start).
  //   • UX-2 — after the first manual keystroke during a live segment, partial
  //     writes stop for the session; a later FINAL segment still appends.
  // Spec #2882 ST-4 (R-4.3, clarification #2) — a write that carries a committed
  // FINAL for this session marks the bar's content as DICTATED. The evidence rule
  // is the #2878 one (`committed` grew past the session baseline); a partial-only
  // session never flips provenance, and a LATER USER EDIT never clears it.
  useEffect(() => {
    if (voice.origin !== 'launcher') return;
    if (cancelledRef.current) return;
    const prevCommitted = prevCommittedRef.current;
    prevCommittedRef.current = voice.committed;
    const base = sessionBaseCommittedRef.current;
    if (voice.committed.startsWith(base) && voice.committed.length > base.length) {
      setBarOrigin(true);
    }
    if (userEditedDuringSessionRef.current) {
      const grew =
        voice.committed.startsWith(prevCommitted) &&
        voice.committed.length > prevCommitted.length;
      if (!grew) return; // suppress partial-only writes
      const segment = voice.committed.slice(prevCommitted.length).trim();
      if (segment) handleQueryChange(joinBarText(barTextRef.current, segment));
      return;
    }
    const scoped =
      base && voice.committed.startsWith(base)
        ? voice.committed.slice(base.length).trimStart()
        : voice.committed;
    handleQueryChange(joinBarText(scoped, voice.partial));
  }, [voice.origin, voice.liveText, voice.committed, handleQueryChange, setBarOrigin]);

  // Spec #2877 ST-5 (DR-10) — the newest FINAL segment, derived from the hook's
  // append-only `committed` text (a final APPENDS its segment; a partial only ever
  // lives in `partial`, so it can never reach this). It feeds the transcript
  // announcer, which must never announce a partial.
  const [finalTranscript, setFinalTranscript] = useState('');
  const committedRef = useRef('');
  useEffect(() => {
    const next = voice.committed;
    const prev = committedRef.current;
    committedRef.current = next;
    if (next.length <= prev.length || !next.startsWith(prev)) return;
    const segment = next.slice(prev.length).trim();
    if (segment) setFinalTranscript(segment);
  }, [voice.committed]);

  // Spec #2878 ST-1r (R-2.5/R-2.6/R-4.2/R-5.1) — the autosend finalize commit.
  // Fires once on the `launcher`-origin session's END transition (the
  // `listening:false` state event), reads the CURRENT bar text, and is a one-shot
  // per session. It depends on `voice.liveText` as well as `listening` so a final
  // transcript landing just after the state event still commits. At finalize while
  // a generation is in flight `commitBarQuery` is a hard no-op (silent drop, no
  // queue — R-2.4/R-4.2).
  //
  // The commit EVIDENCE is session-scoped, never the bar mirror: the session is
  // committable iff its own `voice.committed` FINAL text grew past the baseline
  // captured at session start. Guarding on a committed FINAL (never `partial`) is
  // exactly what separates Stop from Cancel at the source, so any DOM↔mirror
  // divergence can never become a phantom dispatch (the #2878 round-2 defect).
  useEffect(() => {
    if (!finalizePendingRef.current) return;
    if (voice.origin !== 'launcher' || voice.listening) return;
    if (cancelledRef.current) {
      // R-3.1 — a cancel suppresses the commit (the restore already happened).
      finalizePendingRef.current = false;
      return;
    }
    // ST-1r (E-1) — an end carrying a typed error (device loss / failure) is a
    // CANCEL: restore the pre-session text once, never commit. The shipped wire
    // cannot distinguish a backend cancel from a stop, so the committed-final
    // evidence below closes the silent/partial gap while this guard covers the
    // typed-error end.
    if (voice.errorCode !== null) {
      finalizePendingRef.current = false;
      if (!restoredAfterSessionRef.current) {
        restoredAfterSessionRef.current = true;
        handleQueryChange(preSessionTextRef.current);
      }
      return;
    }
    // ST-1r — the append-only, session-scoped evidence rule (same as the
    // live-text effect): only a FINAL that grew `committed` past this session's
    // baseline is committable. A partial alone never commits.
    const base = sessionBaseCommittedRef.current;
    const hasCommittedFinal =
      voice.committed.startsWith(base) && voice.committed.length > base.length;
    if (!hasCommittedFinal) {
      // R-3.2 — a finalize that produced no recognized text restores the
      // pre-session text ONCE per session, then STAYS armed: a final may still be
      // in flight (the effect re-runs on the `voice.committed`/`voice.liveText`
      // deps). The once-guard stops a later manual edit being clobbered.
      if (!restoredAfterSessionRef.current) {
        restoredAfterSessionRef.current = true;
        // Spec #2887 ST-7 (R-5e) — a threshold-crossed launcher HOLD that WENT
        // LIVE and committed NO final transcript captured nothing instead of
        // typing the character the user's press would have typed. Generalized
        // from the shipped tap / never-live rules: exactly ONE ordinary space
        // lands, through the ordinary typed path, ONCE per session (the same
        // once-guard as the restore — a later manual edit is never clobbered).
        // The now-instant resident engine is what makes this case real, so this
        // is the guard that keeps an intended space from becoming a lost
        // character. A BLUR is not a release (`releaseFinalizeRef`) and a cancel
        // never reaches here, so both keep the shipped restore-only behaviour.
        if (holdSessionRef.current && releaseFinalizeRef.current) {
          handleQueryChange(preSessionTextRef.current + spaceWriteForVerdict('no-words-space'));
          return;
        }
        handleQueryChange(preSessionTextRef.current);
      }
      return;
    }
    // The finalize decision is made from here on — never re-arm (including the
    // empty-text branch below), so a post-session manual edit can never be
    // auto-dispatched.
    finalizePendingRef.current = false;
    const text = barTextRef.current.trim();
    if (text === '') return;
    if (!voiceAutosend) return; // R-2.6 — autosend OFF: text stays, no dispatch.
    // Spec #2882 ST-5 (R-2.5) — this is the ONLY addition to the finalize effect:
    // a BLUR stop keeps the recognized words but must never dispatch them (a
    // release is the send consent, a blur is not). One-shot, and it sits AFTER the
    // session-scoped evidence rule (which is untouched) and BEFORE the commit, so
    // a suppressed finalize can never be replayed or double-counted.
    if (suppressAutosendOnceRef.current) {
      suppressAutosendOnceRef.current = false;
      return;
    }
    if (autosendFiredRef.current) return;
    autosendFiredRef.current = true;
    // Spec #2882 ST-4 (R-4.1/clarification #2) — a finalize commit is ALWAYS a
    // capture's transcript, so its provenance is `dictated` by construction: the
    // autosend path delivers to Fredo and can NEVER open an app, whatever the
    // transcript spells.
    commitBarQuery(text, 'dictated');
  }, [
    voice.listening,
    voice.origin,
    voice.liveText,
    voice.committed,
    voice.errorCode,
    voiceAutosend,
    commitBarQuery,
    handleQueryChange,
  ]);

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
          // cancel path (suppress the autosend commit, restore the draft).
          if (listeningRef.current) suppressAutosendAndRestore();
          void cancelVoice();
          return;
        }
        // Spec #2877 ST-5 ((g).2, binding) — a live dictation session cancels
        // FIRST (the launcher stays open, the text is kept); otherwise Escape
        // keeps today's exact behavior (shortcut-open → closeOverlay with
        // focus-origin restore; non-shortcut → idle collapse).
        // #2878 ST-1 — set the cancel guard BEFORE `cancel()` so the autosend
        // commit is suppressed and the pre-session text is restored (R-3.1/3.2).
        if (listeningRef.current) {
          suppressAutosendAndRestore();
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
      //                          mutation of the bar: the live text is provisional);
      //   dictated content     → deliver to Fredo or nothing — NEVER an app (R-4.3);
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
          textOrigin: dictationOriginRef.current ? 'dictated' : 'typed',
          companionActive,
          companionBusy,
          captureLive,
        });
        if (verdict.kind === 'none' && verdict.reason === 'listening') return;

        const q = query.trim();
        // The empty branch keeps today's grid launch — it must never be reachable
        // from the autosend path (R-5.1). A generation in flight keeps the pre-#2882
        // GLOBAL no-op here (the truth table's `companionBusy` row outranks the
        // empty-query row); a TYPED app match below still launches while replying.
        if (q === '') {
          if (companionBusy) return;
          openSelected();
          return;
        }
        // #2878 ST-1 — the SAME commit path the autosend finalize uses (one
        // dispatch route — G-149). The content PROVENANCE comes from the
        // synchronous ref, so a transcript written earlier in this commit is
        // already `dictated` (clarification #2).
        commitBarQuery(q, dictationOriginRef.current ? 'dictated' : 'typed');
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
          // The persisted enablement + ST-3's fail-closed readiness probe: unknown
          // readiness ⇒ NOT armed ⇒ Space stays natively ordinary (contract 4c).
          voiceUsable: voiceEnabled && sttModel.ready,
          busy: companionBusy,
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
      companionBusy,
      companionActive,
      captureLive,
      filteredEntries,
      query,
      open,
      closeOverlay,
      cancelVoice,
      suppressAutosendAndRestore,
      armHold,
      resetHoldGesture,
      voiceEnabled,
      sttModel.ready,
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
        // R-2.3 — stop listening. The backend emits the final, the existing
        // live-text effect lands it as ordinary editable text, and the existing
        // finalize effect decides delivery (R-4.1/R-4.2). NO space is inserted.
        // Spec #2887 ST-7 (R-5e) — the RELEASE is the finalize gesture: mark it
        // so a word-less hold lands exactly one ordinary space when the finalize
        // effect finds no committed final. A blur/cancel never sets this (it is
        // not a release), so their shipped behaviour is untouched.
        releaseFinalizeRef.current = true;
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
        css={DESKTOP_TEXTURE_CSS}
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
            busy={companionBusy}
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
              suppressAutosendAndRestore();
              void cancelVoice();
            }}
            // #2878 ST-2 (UX-2) — the user corrected the bar during a live
            // segment: stop partial writes for the session (finals still append).
            onUserEdit={() => {
              userEditedDuringSessionRef.current = true;
            }}
            // Spec #2882 ST-5 (R-2.5.6/AC3) — a HOLD-origin start failure is
            // SILENT: no alert, no error text (exactly one ordinary space lands on
            // the release). A failure that arrives with no hold start in flight —
            // the app-global `stt:state` channel — still surfaces the curated copy.
            voiceErrorMessage={holdFailureMuted ? null : voiceStartErrorCopy(voice.errorCode)}
            finalTranscript={finalTranscript}
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
