/**
 * Spec #3120 (rework) ST-2 — the teleport-attached instruction composer.
 *
 * The ONE conversation surface: a compact card that opens adjacent to Fredo on
 * the teleport-in settle, auto-focuses its input, grounds the turn on the app it
 * is aimed at, and submits through the existing companion `ask` (the same
 * skill-aware dispatch funnel — never a second route). It is deliberately NOT a
 * chat panel: no transcript, no history, no persistence, and it adds NO
 * `aria-live` region and NO document-level key listener.
 *
 * Placement is the pure `computeComposerPlacement` decision (ranked
 * `above > right > left`, never `below`), so the card can never cover Fredo or
 * the visible SpeechBubble. The two bound QA hooks on the root
 * (`data-composer-placement`, `data-composer-clearance`) expose the measured
 * decision (F-166).
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Icon, Text, chakra } from '@chakra-ui/react';
import { LuArrowUp, LuX } from 'react-icons/lu';

import { readCompanionAppRefs } from '../../installed-apps/companionTargetRefs';
import { resolveNamedAppMention } from '../../companion/composerTarget';
import type { CompanionTurnTarget } from '../../companion/composerTarget';
import type { ReplyAvatarRect, ReplyRect } from './replySurfaceLayout';
import {
  COMPOSER_H,
  COMPOSER_MAX_H,
  COMPOSER_W,
  ORDER_TICKER_ROW_H,
  REPLY_MARGIN,
  computeComposerPlacement,
  deriveAwayRegion,
} from './replySurfaceLayout';
import { AVATAR_SM } from '../fredo-avatar';
import {
  ORDER_HOLD_PENDING_CUE_MS,
  ORDER_HOLD_THRESHOLD_MS,
  isOrderFieldCancelled,
  orderSpaceWriteForVerdict,
  resolveOrderHoldKeyDown,
  resolveOrderHoldKeyUp,
} from '../../order/orderGesture';
import {
  STARTING_VOICE_INPUT_COPY,
  DICTATION_CANCELLED_ANNOUNCEMENT,
  MODEL_AUDIO_LISTENING_ANNOUNCEMENT,
} from '../../../applications/home/components/launcher/LauncherCommandBar';
import type { OrderFlight } from '../../order/orderFlight';
import type { OrderInvocation } from '../../order/orderActions';

// ── Bound DOM / copy (Architect's names block — consumed verbatim) ───────────

export const COMPANION_COMPOSER_TESTID = 'fredo-companion-composer';
export const COMPANION_COMPOSER_INPUT_TESTID = 'fredo-companion-composer-input';
export const COMPANION_COMPOSER_SUBMIT_TESTID = 'fredo-companion-composer-submit';
export const COMPANION_COMPOSER_TARGET_TESTID = 'fredo-companion-composer-target';
export const COMPANION_COMPOSER_DISMISS_TESTID = 'fredo-companion-composer-dismiss';

export const COMPANION_COMPOSER_ARIA_LABEL = 'Tell Fredo what to change';
export const COMPANION_COMPOSER_INPUT_LABEL = 'Instruction for Fredo';
export const COMPANION_COMPOSER_PLACEHOLDER = 'Tell Fredo what to change…';
export const COMPANION_COMPOSER_SUBMIT_LABEL = 'Send instruction';
export const COMPANION_COMPOSER_DISMISS_LABEL = 'Close instruction box';
export const COMPANION_COMPOSER_TARGET_PREFIX = 'for ';
export const COMPANION_COMPOSER_NO_TARGET_COPY = 'No app in front of Fredo';

// ── Spec #3243 ST-8 — the hold-Space gesture's own copy ──────────────────────
//
// The order field needs its OWN promise string, not the launcher bar's
// (`HOLD_AVAILABLE_PLACEHOLDER = 'search, or hold Space to dictate'`): at
// `COMPOSER_W = 320` the textarea has ~140 px after the chip and the two 28 px
// controls, so a 40-character promise would be ellipsised in the placeholder —
// the affordance would be invisible at the exact moment it is offered.
/** The gesture's promise. Short enough to paint inside the order field. */
export const COMPANION_COMPOSER_HOLD_PROMISE = 'Hold Space to speak';
/** The live-capture placeholder. `Listening…` is never used pre-capture. */
export const COMPANION_COMPOSER_LISTENING_PLACEHOLDER = 'Listening… release Space to finish';
/** The close control's name while a capture is live — it states BOTH effects. */
export const COMPANION_COMPOSER_CANCEL_DICTATION_LABEL = 'Cancel dictation and close';
/**
 * The visually-hidden description's `id`. The field's `aria-describedby` points
 * at it ONLY while the promise holds (mirroring the shipped
 * `fredo-command-hint-sr` shape: a description read once on focus, never a
 * second live region, and never present when the capability is absent).
 */
export const COMPANION_COMPOSER_HINT_SR_TESTID = 'fredo-companion-composer-hint-sr';
export const COMPANION_COMPOSER_HINT_SR_ID = 'fredo-companion-composer-hint';
/**
 * The field's capture state — the ONE structural reading of the gesture.
 *
 * `idle` is also the resting state, so the attribute is ALWAYS present (`idle`
 * is a claim too: "nothing is capturing"). A placeholder alone could not
 * distinguish `armed` from rest at all, which is what would weaken "no silent
 * capture" to "no silent LIVE capture".
 */
export const COMPANION_COMPOSER_CAPTURE_ATTR = 'data-order-capture';
export type CompanionOrderCaptureState = 'idle' | 'armed' | 'starting' | 'listening';

// ── Spec #3243 ST-8 — the order ticker + undo controls ──────────────────────
/**
 * The ticker ROW root. It is STATIC text in the accessibility tree, never a live
 * region: its appearance is not an announcement. Making it live "so the states
 * are easy to observe" would violate AC-3 on its own — the ONE polite region
 * stays `CompanionEntity`'s, and this row is the durable *record* of an order
 * (recognition over recall), not a notification.
 */
export const ORDER_TICKER_TESTID = 'fredo-order-ticker';
/** The `data-order-state` attribute: the five states, read without parsing prose. */
export const ORDER_TICKER_STATE_ATTR = 'data-order-state';
/**
 * The app the ORDER runs in — the app resolved at SUBMIT, NOT the app the user
 * is in now. After a move the target chip names the new app while this keeps
 * naming the original one: two claims, one subject each (G-475b).
 */
export const ORDER_TICKER_TARGET_APP_ATTR = 'data-order-target-app';
/** The Undo control. REMOVED from the tree when its record is gone — never disabled. */
export const ORDER_UNDO_TESTID = 'fredo-order-undo';
/** `Undo <label>` — the control's own name, bound to the record's label. */
export function orderUndoLabel(actionLabel: string): string {
  return `Undo ${actionLabel}`;
}

/** Inner padding on the composer card (the textarea takes the rest). */
const COMPOSER_PAD = 4;

export interface CompanionComposerProps {
  readonly surface: 'seat' | 'overlay';
  /**
   * #3120 (rework) ST-2-R4 — the provider's `composerRequestSeq`. It advances on
   * EVERY open request, so the focus layout effect below re-runs per request (a
   * repeated `Ask` re-focuses the input instead of silently no-oping).
   */
  readonly focusNonce: number;
  readonly avatarRect: ReplyAvatarRect | null;
  /** The visible SpeechBubble rect (viewport px), or `null`. */
  readonly avoidRect: ReplyRect | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly target: CompanionTurnTarget;
  readonly onSubmit: (text: string) => void;
  readonly onDismiss: () => void;
  /**
   * Spec #3243 ST-8 — the ONE existing announcement seam, exposed as a prop.
   *
   * This is NOT a second live region: it routes into
   * `CompanionEntity`'s single `role="status" aria-live="polite"` node, which
   * stays the only one in the tree. A gesture cue that needs announcing (the live
   * edge, a cancel) therefore has a channel that already exists — and the
   * composer becomes assertable without a DOM live region, because a test can
   * pass a stub and read the call.
   */
  readonly onAnnounce?: (text: string) => void;
  /**
   * Spec #3243 ST-8 — is voice capture genuinely usable right now?
   * `voiceEnabled && !isPerformanceGateActive()` and a capture can start. FAIL
   * CLOSED: when this is false the gesture does not arm AND the promise
   * (placeholder + `aria-describedby` description) is absent — a permanent
   * promise would claim a capability the field does not have.
   */
  readonly voiceUsable?: boolean;
  /**
   * Spec #3243 ST-8 — a companion reply generation is in flight. A hold must not
   * promise a capture while a reply owns the turn (the shipped precedence's
   * `busy` term).
   */
  readonly busy?: boolean;
  /**
   * Spec #3243 ST-8 — the capture lifecycle, owned by the caller.
   *
   * The composer renders the gesture's STATE; it does not own the microphone.
   * `start` is called once the hold crosses `ORDER_HOLD_THRESHOLD_MS`, `stop` on a
   * release that finalized, and `cancel` on every one of AC-2's three cancels.
   * Leaving this undefined keeps the field's pre-#3243 behaviour byte-identical
   * (no gesture, no capture attribute beyond `idle`).
   */
  readonly capture?: CompanionCaptureControls;
  /**
   * Spec #3243 ST-8 — the in-flight order record to render, or `null`.
   *
   * The composer renders it; it does not own it. The record lives in the
   * module-scoped `orderFlight` store because the DISPATCHER lives in the Home
   * tree while the composer lives here — two React trees, so a ref or local
   * state could not carry an order across that boundary (AC-3).
   */
  readonly orderFlight?: OrderFlight | null;
  /**
   * Spec #3243 ST-8 — activate the Undo control. Returns `true` when an undo
   * landed, so the surface need not poll the registry to decide what to say.
   */
  readonly onUndoOrder?: () => void;
  /** The newest undo record's label, for the control's accessible name. */
  readonly undoLabel?: string | null;
}

/** The order ticker's own copy for the `running` state (see `orderReply.ts` for the rest). */
export const ORDER_TICKER_WORKING_COPY = 'Working in {app}…';

/** Format the running ticker text with the ORIGINAL app's name. */
export function orderTickerWorkingText(appName: string): string {
  return ORDER_TICKER_WORKING_COPY.replace('{app}', appName);
}

/** The capture lifecycle the caller supplies (see `capture` above). */
export interface CompanionCaptureControls {
  /** Begin a capture for this order field. */
  start: () => void;
  /** The release finalized a live capture (the clip is committed). */
  stop: () => void;
  /** Discard — AC-2's three cancels. Must never dispatch and never write a space. */
  cancel: () => void;
  /** Has the backend confirmed the capture is live? (`stt:state.listening`) */
  readonly live: boolean;
}

/**
 * A synthetic footprint used only until the entity's first avatar measurement
 * lands (one commit). It sits near the bottom-right so the first paint is
 * on-screen and clear of the (equally unmeasured) avatar.
 */
function fallbackAvatar(viewport: { readonly width: number; readonly height: number }): ReplyAvatarRect {
  const width = AVATAR_SM.width;
  const height = AVATAR_SM.height;
  const left = Math.max(REPLY_MARGIN, viewport.width - width - REPLY_MARGIN * 2);
  const top = Math.max(REPLY_MARGIN, viewport.height - height - REPLY_MARGIN * 2);
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function resolveTarget(target: CompanionTurnTarget, text: string): { appId: string | null; copy: string } {
  // A named app in the instruction overrides the default for the displayed chip
  // exactly as the submit path resolves it (both consume the ONE pure matcher).
  // Spec #3244 ST-5 — the app list spans BOTH registries (built-in + installed)
  // through the ONE projection, so the chip and the submit path never drift.
  const apps = readCompanionAppRefs();
  const namedId = resolveNamedAppMention(text, apps);
  const appId = namedId ?? target.appId;
  const appName = namedId
    ? (apps.find((application) => application.id === namedId)?.name ?? null)
    : target.appName;
  if (appId === null || appName === null || appName.trim() === '') {
    return { appId, copy: COMPANION_COMPOSER_NO_TARGET_COPY };
  }
  return { appId, copy: `${COMPANION_COMPOSER_TARGET_PREFIX}${appName}` };
}

/**
 * Return focus to the landing application when the element focused before the
 * composer opened is gone. NEVER `body`: the target app frame, then any app
 * root, then the document root (a focusable, non-body fallback).
 */
function focusLandingApp(appId: string | null): void {
  if (typeof document === 'undefined') return;
  const escaped = appId === null ? null : appId.replace(/"/g, '\\"');
  const target = escaped === null
    ? null
    : document.querySelector<HTMLElement>(`[data-fredo-app-id="${escaped}"]`);
  const root = target ?? document.querySelector<HTMLElement>('[data-fredo-app-id]');
  const element: HTMLElement = root ?? document.documentElement;
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus();
}

export function CompanionComposer(props: CompanionComposerProps): React.ReactElement {
  const {
    surface, focusNonce, avatarRect, avoidRect, viewport, target, onSubmit, onDismiss,
    onAnnounce, voiceUsable = false, busy = false, capture,
    orderFlight, onUndoOrder, undoLabel,
  } = props;

  const [value, setValue] = useState('');
  // The textarea's content height (excludes the card padding). Resting 32 px so
  // the whole card is COMPOSER_H (40 px) before any input; capped so the card is
  // at most COMPOSER_MAX_H (96 px) and then scrolls (UIUX-D3).
  const [textHeight, setTextHeight] = useState(COMPOSER_H - COMPOSER_PAD * 2);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const preOpenFocusRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The promise holds only when nothing is in flight, voice is usable AND a
  // capture lifecycle is actually wired. Without `capture` the field cannot
  // capture, so promising it would be exactly the false-capability claim the
  // conditional description exists to prevent.
  const promiseAvailable = voiceUsable && !busy && capture !== undefined;

  // The chip's resolved target (read by `dismiss` for focus restoration, and by
  // the render below). Declared here so every handler can reference it.
  const resolvedTarget = resolveTarget(target, value);

  /** Dismiss the box, returning focus to where the user was (never `body`). */
  const dismiss = (): void => {
    const previous = preOpenFocusRef.current;
    if (
      previous !== null &&
      previous !== inputRef.current &&
      previous.isConnected &&
      typeof previous.focus === 'function'
    ) {
      previous.focus();
    } else {
      // The landing app frame / an app root / the document root — NEVER `body`.
      focusLandingApp(resolvedTarget.appId);
    }
    onDismiss();
  };

  const submit = (): void => {
    const text = value.trim();
    if (text === '') {
      // Empty submit is a synchronous no-op — focus stays in the instruction box.
      inputRef.current?.focus();
      return;
    }
    onSubmit(text);
    setValue('');
    inputRef.current?.focus();
  };

  // ── Spec #3243 ST-8 — the hold-Space gesture's wiring (AC-2) ────────────────
  //
  // EVERY decision is ST-2's pure module (`orderGesture`, which delegates the
  // precedence to the shipped `launcherSpaceHold`). This block owns only the
  // LIFECYCLE: two bounded timers, the three cancels, and the DOM state.
  //
  // NOT a platform chord: the keydown is the textarea's own React `onKeyDown`
  // (every event it sees was routed by the browser to this focused field) and the
  // keyup is bound on the same element. No `document`/`window` listener is added,
  // so `platformChords.ts` is untouched and the three chords stay three — and a
  // focused textarea classifies `text-entry`, so `primary+space` could not reach
  // the launcher from here anyway.
  const [captureState, setCaptureState] = useState<CompanionOrderCaptureState>('idle');
  // Refs mirror the state for the handlers: a keydown/keyup pair can arrive in
  // one dispatch, and a handler reading a stale render's state would mis-resolve.
  const holdArmedRef = useRef(false);
  const thresholdCrossedRef = useRef(false);
  const captureLiveRef = useRef(false);
  const disarmedRef = useRef(false);
  /** A release landed before the capture went live — cancel on the rise edge. */
  const cancelOnLiveRef = useRef(false);
  /** The gesture was armed or crossed the threshold this session (for the edge). */
  const gestureActiveRef = useRef(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGestureTimers = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (pendingCueTimerRef.current !== null) {
      clearTimeout(pendingCueTimerRef.current);
      pendingCueTimerRef.current = null;
    }
  }, []);

  /** End the gesture WITHOUT touching the session — the caller owns stop/cancel. */
  const resetGesture = useCallback(() => {
    clearGestureTimers();
    holdArmedRef.current = false;
    thresholdCrossedRef.current = false;
    disarmedRef.current = false;
    gestureActiveRef.current = false;
    setCaptureState('idle');
  }, [clearGestureTimers]);

  /** AC-2's three cancels, plus the unmount path — one exit, one contract. */
  const cancelGesture = useCallback((reason: 'escape' | 'close-control' | 'blur' | 'unmount') => {
    const armed = holdArmedRef.current;
    const crossed = thresholdCrossedRef.current;
    const live = captureLiveRef.current;
    // Nothing to cancel: stay silent. An Escape in a field with no gesture is the
    // ordinary dismiss, and a blur before any arm is just focus moving.
    if (!armed && !crossed && !live) return;

    // A genuinely LIVE capture is the only thing worth announcing: it captured
    // something the user expects to be finished. A pre-capture disarm claims
    // nothing, so announcing would be inventing a retraction.
    if (live) onAnnounce?.(DICTATION_CANCELLED_ANNOUNCEMENT);
    // Anything past the threshold but not yet live must be cancelled ON ITS RISE
    // EDGE, or the microphone stays hot after we have given up on the gesture.
    cancelOnLiveRef.current = crossed && !live;

    // A cancel writes NOTHING (R-2c) — a different verdict from an unfulfilled
    // hold, which writes exactly one space.
    disarmedRef.current = true;
    capture?.cancel();
    if (reason !== 'unmount') resetGesture();
  }, [capture, onAnnounce, resetGesture]);

  /** AC-2 cancel #2 — the close control cancels FIRST, then the dismiss runs. */
  const handleDismiss = useCallback(() => {
    cancelGesture('close-control');
    dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `dismiss` is a plain
    // per-render closure over props/refs; re-creating this callback per render is
    // correct and cheap, and adding it to deps would fight the shipped focus flow.
  }, [cancelGesture]);

  /** AC-2 cancel #3 — field blur OUTSIDE the composer root. */
  const handleBlur = useCallback((event: React.FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget as Node | null;
    const root = rootRef.current;
    // Focus moving to a control INSIDE the composer is NOT a cancel: the close
    // control blurs the textarea, and cancelling here too would cancel twice for
    // one click (two `Dictation cancelled` announcements).
    if (root !== null && next !== null && root.contains(next)) return;
    cancelGesture('blur');
  }, [cancelGesture]);

  // Unmount is a cancel too (no overlapping capture outlives its own field).
  useEffect(() => () => {
    const active = holdArmedRef.current || thresholdCrossedRef.current || captureLiveRef.current;
    if (active) {
      // The unmount path cannot setState; it only releases the microphone.
      capture?.cancel();
    }
    clearGestureTimers();
    // `capture`/`clearGestureTimers` only: a changing callback identity must not
    // re-run a cleanup that releases a live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── The live edge: backend confirmation of a capture ────────────────────────
  // `capture.live` is the `stt:state.listening` fact. The rise edge is where the
  // ONE announcement fires (exactly once per capture, never pre-capture), and
  // where a release that beat the start cancels the late session so the
  // microphone can never stay hot.
  const captureLiveProp = capture?.live === true;
  useEffect(() => {
    const was = captureLiveRef.current;
    captureLiveRef.current = captureLiveProp;
    if (!captureLiveProp || was) return;

    // Capture is live: the pending cue has done its job.
    clearGestureTimers();
    if (gestureActiveRef.current) {
      setCaptureState('listening');
      // The ONE announcement, on the rise edge. Not before: a pre-capture claim
      // would say "listening" while nothing is.
      onAnnounce?.(MODEL_AUDIO_LISTENING_ANNOUNCEMENT);
    }
    if (cancelOnLiveRef.current) {
      cancelOnLiveRef.current = false;
      // The stale-hold guard: this session arrived after we gave up on it.
      capture?.cancel();
      resetGesture();
    }
  }, [captureLiveProp, capture, onAnnounce, resetGesture, clearGestureTimers]);

  /** The hold crossed the threshold: start the capture and the pending cue. */
  const beginCapture = useCallback(() => {
    thresholdCrossedRef.current = true;
    setCaptureState('starting');
    // The bounded `starting voice input…` cue — the same shipped window, so the
    // loop never looks dead while the engine loads.
    pendingCueTimerRef.current = setTimeout(() => {
      pendingCueTimerRef.current = null;
    }, ORDER_HOLD_PENDING_CUE_MS);
    capture?.start();
  }, [capture]);

  /** Arm the gesture: the keydown has been consumed, the threshold timer starts. */
  const armHold = useCallback(() => {
    holdArmedRef.current = true;
    thresholdCrossedRef.current = false;
    disarmedRef.current = false;
    cancelOnLiveRef.current = false;
    gestureActiveRef.current = true;
    setCaptureState('armed');
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      if (disarmedRef.current) return;
      beginCapture();
    }, ORDER_HOLD_THRESHOLD_MS);
  }, [beginCapture]);

  /**
   * Write text at the CARET, not the end.
   *
   * The shipped launcher bar appends (`query + text`) because a one-line bar puts
   * the caret where the user is. This field is a MULTI-LINE textarea: a tap with
   * the caret mid-text must insert at `selectionStart` and advance the caret — a
   * `value + ' '` would move the user's character to the end of their sentence,
   * which is a lost keystroke dressed as a kept one.
   */
  const writeAtCaret = useCallback((text: string) => {
    if (text === '') return;
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    setValue(next);
    const caret = start + text.length;
    // Restore the caret after React commits the new value.
    queueMicrotask(() => {
      const node = inputRef.current;
      if (node === null) return;
      node.setSelectionRange(caret, caret);
    });
  }, [value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // An IME composition never arms a capture (the shipped short-circuit).
    if (event.nativeEvent.isComposing) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      // AC-2 cancel #1, then the shipped dismiss (the box closes).
      cancelGesture('escape');
      dismiss();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key !== ' ') return;

    // The gesture branch. A non-empty field / unusable voice / in-flight reply
    // resolves to `ordinary-space` and this handler does NOT consume the key, so
    // the native character lands exactly as it always did.
    const verdict = resolveOrderHoldKeyDown({
      holdArmed: holdArmedRef.current,
      isOrderFieldTarget: true,
      fieldIsEmpty: value === '',
      voiceUsable: promiseAvailable,
      busy,
      modified: event.ctrlKey || event.metaKey || event.altKey || event.shiftKey,
      repeat: event.repeat,
    });

    if (verdict === 'hold-arm') {
      // Consume the keydown: the release writes the space if the hold never
      // produced words, so nothing is lost.
      event.preventDefault();
      armHold();
      return;
    }
    if (verdict === 'hold-suppress') {
      // Swallow EVERY keydown while armed, including OS auto-repeats, so a
      // repeat can never restart the capture or insert a run of spaces.
      event.preventDefault();
    }
    // `ordinary-space` falls through untouched.
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== ' ') return;
    if (!holdArmedRef.current && !thresholdCrossedRef.current && !captureLiveRef.current) return;

    const verdict = resolveOrderHoldKeyUp({
      holdArmed: holdArmedRef.current,
      captureLive: captureLiveRef.current,
      thresholdCrossed: thresholdCrossedRef.current,
    });

    event.preventDefault();
    const wasCrossed = thresholdCrossedRef.current;
    clearGestureTimers();
    holdArmedRef.current = false;
    thresholdCrossedRef.current = false;
    gestureActiveRef.current = false;
    setCaptureState('idle');

    if (verdict === 'finalize') {
      // The release IS the finalize control for a live capture — no space.
      capture?.stop();
      return;
    }
    if (verdict === 'cancel-pending') {
      // Crossed the threshold but never went live: cancel the late session so the
      // microphone is never left hot, and type the one space the user meant.
      cancelOnLiveRef.current = wasCrossed && !captureLiveRef.current;
      capture?.cancel();
    }
    // The three no-words verdicts each write exactly ONE ordinary space at the
    // caret (`spaceWriteForVerdict` is the ONE source of "how much").
    writeAtCaret(orderSpaceWriteForVerdict(verdict));
  };

  // Capture the pre-open focus and open ⇒ focus in a LAYOUT effect (no click, no
  // rAF chain, no effect loop). The capture happens BEFORE the input is focused,
  // so Esc can return focus to the element the user was on.
  //
  // #3120 (rework) ST-2-R4 — keyed on `focusNonce` (the provider's
  // `composerRequestSeq`), NOT mount-only: EVERY open request re-focuses the
  // input, including a repeat `Ask` while the box is already open. An already
  // focused input is never captured as its own "pre-open" element.
  useLayoutEffect(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== inputRef.current &&
      active !== document.body &&
      active !== document.documentElement
    ) {
      preOpenFocusRef.current = active;
    }
    inputRef.current?.focus();
  }, [focusNonce]);

  // Auto-grow: measure the wrapped content height and apply the capped size.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const previous = el.style.height;
    el.style.height = 'auto';
    const natural = el.scrollHeight;
    el.style.height = previous;
    const next = Math.max(
      COMPOSER_H - COMPOSER_PAD * 2,
      Math.min(COMPOSER_MAX_H - COMPOSER_PAD * 2, natural),
    );
    setTextHeight((current) => (current === next ? current : next));
  }, [value]);

  const targetCopy = resolvedTarget.copy;

  // The ticker consumes one bounded row; the card's measured height includes it,
  // so the placement arithmetic can never put the card on top of Fredo (G-253:
  // derive from the rendered stack, never a nominal sum).
  const hasTicker = orderFlight !== undefined && orderFlight !== null;

  const boxHeight = textHeight + COMPOSER_PAD * 2 + (hasTicker ? ORDER_TICKER_ROW_H : 0);
  const avatar = avatarRect ?? fallbackAvatar(viewport);
  const placement = computeComposerPlacement({
    avatar,
    region: deriveAwayRegion(null, viewport),
    viewport,
    size: { width: COMPOSER_W, height: boxHeight },
    avoid: avoidRect,
  });

  // ── The gesture's rendered state (Spec #3243 ST-8) ──────────────────────────
  // `listening` is reachable ONLY once the capture is genuinely live, so a
  // pre-capture state can never claim it (the honesty rule the launcher bar
  // already enforces with its own cue).
  const listening = captureState === 'listening';
  const starting = captureState === 'starting';
  // The promise is offered ONLY while it holds: voice usable, nothing in flight,
  // and the field empty. A permanent promise would claim a capability the field
  // does not have — a false-capability claim is a defect, not polish.
  const showHoldPromise = promiseAvailable && value === '' && !listening && !starting;
  const hintDescribedBy = showHoldPromise ? COMPANION_COMPOSER_HINT_SR_ID : undefined;

  return (
    <Box
      ref={rootRef}
      role="group"
      aria-label={COMPANION_COMPOSER_ARIA_LABEL}
      data-testid={COMPANION_COMPOSER_TESTID}
      data-composer-placement={placement.placement}
      data-composer-clearance={Math.round(placement.clearance)}
      data-composer-surface={surface}
      data-order-capture={captureState}
      position="fixed"
      left={`${placement.left}px`}
      top={`${placement.top}px`}
      width={`${placement.width}px`}
      height={`${placement.height}px`}
      zIndex={surface === 'overlay' ? 103 : 120}
      display="flex"
      flexDirection="column"
      alignItems="stretch"
      gap="1"
      padding={`${COMPOSER_PAD}px`}
      bg="bg.surface"
      border="1px solid"
      // The live-capture mark is a TOKEN, never an alpha-append onto a var()
      // (`var(--accent-primary)22` is invalid CSS — #2770 round 5).
      borderColor={listening ? 'accent.strong' : 'accent.border'}
      borderRadius="md"
      boxShadow="dialog"
    >
      <Box display="flex" alignItems="flex-end" gap="1">
      <Text
        data-testid={COMPANION_COMPOSER_TARGET_TESTID}
        flexShrink={0}
        alignSelf="center"
        maxWidth="104px"
        px="2"
        py="2px"
        bg="bg.subtle"
        borderRadius="sm"
        color="fg.muted"
        fontSize="11px"
        lineHeight="16px"
        lineClamp={1}
        title={targetCopy}
      >
        {targetCopy}
      </Text>

      <chakra.textarea
        ref={inputRef}
        data-testid={COMPANION_COMPOSER_INPUT_TESTID}
        aria-label={COMPANION_COMPOSER_INPUT_LABEL}
        // The conditional description: present ONLY while the gesture can arm.
        aria-describedby={hintDescribedBy}
        placeholder={
          listening
            ? COMPANION_COMPOSER_LISTENING_PLACEHOLDER
            : starting
              ? STARTING_VOICE_INPUT_COPY
              : showHoldPromise
                ? COMPANION_COMPOSER_HOLD_PROMISE
                : COMPANION_COMPOSER_PLACEHOLDER
        }
        value={value}
        rows={1}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={handleBlur}
        flex="1"
        minWidth={0}
        height={`${textHeight}px`}
        resize="none"
        background="transparent"
        border="none"
        outline="none"
        overflowY={textHeight >= COMPOSER_MAX_H - COMPOSER_PAD * 2 ? 'auto' : 'hidden'}
        color="fg.default"
        fontSize="13px"
        lineHeight="18px"
        fontFamily="inherit"
        padding="6px 4px"
        _placeholder={{ color: 'fg.subtle' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
      />

      {/* The visually-hidden mirror the field's `aria-describedby` points at —
          rendered ONLY while the promise holds (the shipped
          `fredo-command-hint-sr` shape). A description, not a live region: it is
          read once when the field takes focus and never re-announced. */}
      {showHoldPromise && (
        <Box
          id={COMPANION_COMPOSER_HINT_SR_ID}
          data-testid={COMPANION_COMPOSER_HINT_SR_TESTID}
          position="absolute"
          width="1px"
          height="1px"
          padding="0"
          margin="-1px"
          overflow="hidden"
          clipPath="inset(50%)"
          whiteSpace="nowrap"
          borderWidth="0"
        >
          {COMPANION_COMPOSER_HOLD_PROMISE}
        </Box>
      )}

      <chakra.button
        type="button"
        data-testid={COMPANION_COMPOSER_SUBMIT_TESTID}
        aria-label={COMPANION_COMPOSER_SUBMIT_LABEL}
        onClick={submit}
        // Send is NOT the way to end a capture: the field is empty and the
        // release is the finalize gesture, so a live capture disables it rather
        // than offering a second, wrong exit.
        disabled={listening}
        flexShrink={0}
        alignSelf="center"
        display="flex"
        alignItems="center"
        justifyContent="center"
        width="28px"
        height="28px"
        borderRadius="sm"
        color="var(--accent-contrast)"
        bg="accent.default"
        cursor="pointer"
        opacity={listening ? 0.5 : undefined}
        _hover={{ bg: 'accent.strong' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
      >
        <Icon as={LuArrowUp} boxSize="16px" aria-hidden="true" />
      </chakra.button>

      <chakra.button
        type="button"
        data-testid={COMPANION_COMPOSER_DISMISS_TESTID}
        // While a capture is live the control's name states BOTH of its effects.
        aria-label={listening ? COMPANION_COMPOSER_CANCEL_DICTATION_LABEL : COMPANION_COMPOSER_DISMISS_LABEL}
        onClick={handleDismiss}
        // Prevent the blur this click would cause: the gesture is cancelled ONCE
        // (by the click), never twice (by the click and then the blur).
        onMouseDown={(event) => event.preventDefault()}
        flexShrink={0}
        alignSelf="center"
        display="flex"
        alignItems="center"
        justifyContent="center"
        width="28px"
        height="28px"
        borderRadius="sm"
        color="fg.muted"
        bg="transparent"
        cursor="pointer"
        _hover={{ bg: 'bg.hover', color: 'fg.default' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
      >
        <Icon as={LuX} boxSize="16px" aria-hidden="true" />
      </chakra.button>
      </Box>

      {/* ── Spec #3243 ST-8 — the order ticker (STATIC, never a live region) ──
          The durable record of the order, and the answer for a user who looks
          back after moving to another app. Its appearance is deliberately NOT an
          announcement: AC-3 requires the MOVE to be silent, and a live region
          here would announce on every state change (the exact defect the plan
          warns about). The text node carries the FULL sentence — CSS lineClamp
          clips paint, never the accessible name. */}
      {orderFlight !== undefined && orderFlight !== null && (
        <Box
          data-testid={ORDER_TICKER_TESTID}
          {...{ [ORDER_TICKER_STATE_ATTR]: orderFlight.state }}
          {...{ [ORDER_TICKER_TARGET_APP_ATTR]: orderFlight.appId }}
          display="flex"
          alignItems="center"
          gap="1"
          height={`${ORDER_TICKER_ROW_H}px`}
          minWidth={0}
        >
          <Text
            flex="1"
            minWidth={0}
            color="fg.muted"
            fontSize="11px"
            lineHeight={`${ORDER_TICKER_ROW_H}px`}
            lineClamp={1}
            // The sighted hover fallback; the accessible text is the full node.
            title={orderFlight.text !== '' ? orderFlight.text : orderTickerWorkingText(orderFlight.appName)}
          >
            {orderFlight.text !== '' ? orderFlight.text : orderTickerWorkingText(orderFlight.appName)}
          </Text>
          {/* The Undo control is REMOVED from the tree once its record is gone —
              never left rendered-but-disabled, which would be a dead control. */}
          {orderFlight.state === 'done' && undoLabel !== undefined && undoLabel !== null && onUndoOrder !== undefined && (
            <chakra.button
              type="button"
              data-testid={ORDER_UNDO_TESTID}
              aria-label={orderUndoLabel(undoLabel)}
              onClick={onUndoOrder}
              flexShrink={0}
              px="2"
              height="20px"
              borderRadius="sm"
              fontSize="11px"
              color="fg.muted"
              bg="transparent"
              cursor="pointer"
              _hover={{ bg: 'bg.hover', color: 'fg.default' }}
              _focusVisible={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
            >
              Undo
            </chakra.button>
          )}
        </Box>
      )}
    </Box>
  );
}
