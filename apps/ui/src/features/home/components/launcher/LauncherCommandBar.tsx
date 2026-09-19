/**
 * Fredo launcher command bar (Spec #2808 ST-3; #2871 ST-3 chat affordances;
 * #2877 ST-5 launcher listening cue).
 *
 * The `>` search-or-command input (desktop-light.png): a centered, ~560px
 * max-width native-capable Chakra text input with an accent `>` chevron prefix
 * and a `—` MINIMIZE control at the right edge (a vertical divider + a short
 * dash whose click collapses the launcher to bare chrome via `onMinimize`).
 * This is a CONTROLLED component — the host owns the query string and the grid
 * filtering; this component renders the query and reports changes up via
 * `onQueryChange`. It is a launcher grid filter, NOT a global command
 * dispatcher (per the ST-3 non-goals), and it is drawn with a native-capable
 * Chakra `Input` (never `NativeSelect`). `onFocus`/`onBlur` report the
 * reached/left-engaged signals to the host (#2819).
 *
 * #2871 ST-3 — chat affordances (presentational/controlled; the host derives).
 *   • `busy` holds `aria-busy` on the input group plus a static accent indicator
 *     next to the prefix glyph for the WHOLE stream (reduced-motion-safe — no
 *     required animation). #2892 ST-5: `busy` means a reply GENERATION is in
 *     flight (the host feeds `replyInFlight`, NOT `isInUse`), so hovering a
 *     completed reply no longer fakes "replying".
 *   • `enterMode` swaps the prefix glyph: `>` chevron for launch/filter, a small
 *     speech-bubble outline for send (both `aria-hidden`).
 *   • `hintLabel` renders inside the existing `endElement` slot as a flex row
 *     `[hint chip][vertical divider][— minimize]`; the chip is hidden ONLY when
 *     `hintLabel` is absent. #2882 ST-4 retires the #2871 `chatAvailable` gate:
 *     the host derives a label whenever Enter has a promise — including an app
 *     match with the companion OFF (`↵ open <App>`) and a dictated transcript
 *     with no companion (`no match`) — so visibility is purely label-driven (a
 *     `chatAvailable` term would hide exactly the truthful chips this spec
 *     adds). The `—` MINIMIZE control stays the LAST item in every state (its
 *     existing `borderLeft` is the vertical divider) and is never replaced.
 *     When the chip shows, the `Input` reserves `paddingEnd` so the typed text
 *     never runs under it.
 *   • State 5 (busy, UI/UX §1): the field shows the `Fredo is replying…`
 *     placeholder and `aria-busy` + the accent indicator stay on for the whole
 *     stream. #2892 ST-5 (AC1): a reply state NEVER sets `readOnly` — the field
 *     is always focusable and typeable while a bubble is on screen; only the
 *     placeholder is keyed on `busy`.
 *
 * #2892 ST-5 — the queued-message affordance (AC5/AC7):
 *   • `queuedCount` (0 = none) drives a quiet passive indicator in the below-bar
 *     status slot (`launcher-command-queued`, id `fredo-command-queued`) whose
 *     copy comes from ST-3's `queuedWaitingCopy` — the bar never re-derives it;
 *   • slot precedence is alert (voice error) > hearing-nothing > queued >
 *     `Shift+Enter` caption, so the queued line never displaces a live message
 *     and at most one line ever shows (`showNewlineCaption` requires
 *     `queuedCount === 0`);
 *   • the searchbox `aria-describedby` is composed from the targets actually
 *     rendered (the hint mirror and/or the queued indicator) — no dangling ids;
 *   • a hidden, ALWAYS-mounted polite live region (`launcher-queued-announcer`)
 *     announces the queue TRANSITIONS only: 0→n and n→m (m≥1) read the waiting
 *     copy; the drain edge n→0 reads `QUEUED_DISPATCH_ANNOUNCEMENT`.
 *
 * #2877 ST-5 — launcher-origin listening affordance (DR-7/DR-10/DR-11), rendered
 * only while the host reports `listening` (the host gates it to a `launcher`-
 * origin session, so exactly ONE indicator shows per session — R-5.3):
 *   • the FROZEN static accent dot `launcher-command-listening` (no pulse);
 *   • a visible `Listening` text chip `launcher-command-listening-chip` and a
 *     tab-reachable Stop control `launcher-command-listening-stop`
 *     (`aria-label="Stop listening"`), inserted before the minimize control;
 *   • the `Listening…` placeholder + accent-tinted border;
 *   • `launcher-command-listening-status` below the bar: the hearing-nothing hint
 *     after `HEARING_NOTHING_MS` of silence, or an inline `role="alert"` with
 *     curated copy when a start failed (the raw backend detail is never the
 *     primary sentence);
 *   • two persistent polite live regions — `voice-listening-announcer` (start/stop
 *     transitions ONLY) and `voice-transcript-announcer` (the newest FINAL
 *     segment only; partials NEVER announce).
 *
 * #2878 ST-2 — the visible cancel/discard affordance (`launcher-command-listening-cancel`,
 * `aria-label="Cancel dictation"`) sits before the Stop control while listening and
 * calls `cancel()` (`stt_cancel`): Escape already discards, this exposes the same
 * gesture to a mouse user. Neither termination launches/sends by itself — the Stop
 * control stays the FINALIZE/commit control (`stt_stop`, the autosend trigger), and
 * only the host's commit step dispatches. `onUserEdit` reports the first manual
 * keystroke during a live segment so the host can stop partial writes (UX-2).
 *
 * #2882 ST-5 — the hold-Space cue (R-2.4); #2887 ST-5 — the cue is now HONEST (R-3):
 *   • `cue: HoldCue` is the binding contract. `'listening'` is reachable ONLY while
 *     `captureLive` (the `listening` prop); the armed window (`'acknowledge'`) and
 *     the bounded start window (`'starting'` / the launch-window `'warming'`) render
 *     the non-listening acknowledgement (`Hold to dictate…`) and never `Listening…`;
 *   • `'starting'`/`'warming'` add the bounded `starting voice input…` chip
 *     (`launcher-command-listening-pending`) in the SAME slot as the Listening chip
 *     — the two are mutually exclusive, so exactly ONE indicator ever shows, and
 *     the reserved gutter accounts for whichever it is;
 *   • the shipped #2882 caller passes the legacy `holdArmed`/`holdPending` booleans;
 *     they map onto `'acknowledge'`/`'starting'` (never a listening claim) and are
 *     superseded by `cue` (ST-7 passes `cue` directly);
 *   • `holdAvailable` drives the S1 promise placeholder (`search, or hold Space to
 *     dictate`) — shown only while the input is focused and empty with a usable
 *     model, so no promise is made when Space is simply an ordinary space.
 *
 * #2887 follow-up — the transition-driven live-region contract (UI/UX §4), on the
 * shipped `voice-listening-announcer`:
 *   • WARM path: exactly ONE announcement, `Listening`, when capture is genuinely
 *     live; nothing is announced before it (the S1 `Hold to dictate…`
 *     acknowledgement is field text, never a live region);
 *   • COLD path: `Starting voice input` the moment the bounded
 *     `launcher-command-listening-pending` chip renders, then `Listening`;
 *   • S3 stop: `Stopped listening`; S4 CANCEL (`cancelSignal`, bumped by the host
 *     on a live Escape / `×`): `Dictation cancelled` with that stop line
 *     SUPPRESSED, so a discarded utterance is never reported as finished;
 *   • announcements stay transition-driven (never per partial/event), and text is
 *     the honesty channel — colour/motion never carries a state.
 *
 * #2883 ST-1 — the field WRAPS, GROWS and CAPS (AC1 input side, R-1.1/1.2/1.3/5.3):
 *   • the single-line `Input` becomes a Chakra `Textarea` that KEEPS
 *     `role="searchbox"` (so every #2882 selector/predicate stays tag-agnostic —
 *     `LauncherShell.tsx:105`, the hold-Space target predicate, `isFromInput`) and
 *     ADDS `aria-multiline="true"`; the element is a native `<textarea>`;
 *   • the query wraps INSIDE the field's content box, which is always inset by the
 *     reserved end-slot gutter (`computeEndPaddingPx` + `hasText`), so no line can
 *     reach the hint chip or the always-present divider + `—` MINIMIZE control;
 *   • geometry (bound numbers): border-box height `20n + 28px` for `n = 1..4`
 *     visual lines → **48 / 68 / 88 / 108 px**, then frozen at the 108 px cap with
 *     `overflow-y:auto` internal scroll. The 28 px is `2 × 13 px padding + 2 × 1 px
 *     border` under the Chakra preflight's `box-sizing: border-box` — the 13 px
 *     padding plus the 1 px border is the design's 14 px visual inset, and it is
 *     what makes the rendered height land EXACTLY on the bound 48/68/88/108
 *     (14 px padding would need a 50 px box at one line and would clip the line);
 *   • `measureFieldHeightPx` maps the field's own content height (rAF-coalesced
 *     read of `scrollHeight`, ≤1 layout read per frame — never per token/keystroke)
 *     to the border-box height; the 1 px top/bottom border is added back because
 *     `scrollHeight` spans the padding box only;
 *   • `Shift+Enter adds a new line` caption renders ONLY while the field is
 *     wrapped (≥2 visual lines) AND the host reports `newlineHint` (companion
 *     active); the static sentence `Shift+Enter starts a new line.` is appended
 *     INSIDE the existing `fredo-command-hint-sr` mirror so `aria-describedby`
 *     keeps its shipped value. Enter's wording is owned by #2882 and untouched.
 *
 * Spec #2897 ST-4 (REQ-3/REQ-4) — the MODEL-AUDIO indicator (`voiceMode='model'`),
 * gated by the ONE pure `deriveModelAudioPhase`:
 *   • `listening` → the accent dot (`launcher-command-listening`) + the
 *     `Fredo is listening` chip (`launcher-command-model-listening-chip`) + the
 *     `×` Cancel / `■` Stop controls + the `Fredo is listening…` placeholder;
 *   • `processing` (Stop delivered the clip; the backend is interpreting) → the
 *     accent dot + the `Fredo is processing your speech…` chip
 *     (`launcher-command-model-processing-chip`) with a decorative `Spinner`
 *     (text carries the state) + the `Fredo is processing…` placeholder, and NO
 *     Stop/Cancel (there is nothing left to cancel);
 *   • `stopped`/`idle` → chip/indicator removed, resting placeholder;
 *   • `error` → the shipped below-bar `role="alert"` surface
 *     (`launcher-command-listening-status`); the curated copy is owned elsewhere.
 *   The mode-agnostic ids (`launcher-command-listening`,
 *   `launcher-command-listening-stop`, `launcher-command-listening-cancel`) are
 *   unchanged in BOTH modes, so keyboard/mouse targets stay stable, and the
 *   shipped `Listening` chip/`Listening…` copy is the ONLY indicator in `'local'`
 *   mode (the `voiceMode` prop defaults to `'local'` — omitted ⇒ byte-identical).
 *   ZERO transcript text: `finalTranscript` is host-suppressed in model mode, and
 *   the transcript announcer stays mounted-but-empty.
 *
 * Spec #2897 ST-5 (REQ-6) — the over-limit, NON-LOSSY bound:
 *   • the pinned ceiling reaches the bar as a NUMBER (`modelAudioLimitMs`, from
 *     the backend's `stt:state.limitMs`) — the UI never hardcodes a duration, so
 *     the copy and the backend constant cannot disagree;
 *   • during the LAST `MODEL_AUDIO_WARN_S` seconds the listening chip appends a
 *     countdown (`Fredo is listening · 10s left`) — the bound is never a surprise;
 *   • when the capture auto-stops at the bound (`limitReached`), the chip hands
 *     over to `processing` and a polite BELOW-BAR line
 *     (`launcher-command-model-limit-status`, `var(--status-warning)`) states the
 *     real bound: `That's the 30-second limit — Fredo has your recording and is
 *     responding.` It is a NORMAL terminal capture state — never `role="alert"` —
 *     and the clip is kept whole and delivered (`truncated:false` upstream).
 *   • the below-bar slot precedence becomes: alert (voice error) > model-audio
 *     limit > hearing-nothing > queued > newline caption.
 *
 * Inactive-companion invariance (AC4): every new prop is OPTIONAL and defaults to
 * today's rendering (`voiceMode='local'` / `enterMode='launch'` / no `hintLabel` /
 * `busy=false` / `listening=false` / no stop or cancel handler / no error / no
 * final transcript / `voiceEnabled=false`) — no chip, no glyph swap, no reserved
 * padding, and `aria-busy` is omitted (not rendered as `"false"`). #2882 ST-4
 * deliberately
 * supersedes the #2871 `chatAvailable`-gated byte-identity: the chip now shows
 * whenever the host supplies a label, and `aria-keyshortcuts` is an
 * unconditional `Control+Space` (the chord always opens/focuses the bar, so it
 * is no longer a voice affordance).
 *
 * Token-native contract (AC5): every color is a theme CSS var referenced
 * directly (`var(--card-bg)`, `var(--border-color)`, `var(--accent-primary)`),
 * a Chakra semantic token (`accent.default`, `accent.subtle`, `fg.default`,
 * `fg.muted`), or a shared `tint()` color-mix. There is NO hardcoded hex/rgba and
 * NO `var(--x)NN` alpha-append anywhere in this file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Box, InputGroup, Spinner, Textarea } from '@chakra-ui/react';

import { tint } from '../../../../shared/utils/colorTint';
import type { VoiceModelAudioPhase } from '../../../../shared/hooks/useVoiceDictation';
import {
  QUEUED_WAITING_TESTID,
  queuedWaitingCopy,
} from '../../../../shared/components/companion/companionDispatch';

/** Pending Enter action, derived by the host (UI/UX §1); presentational only. */
export type LauncherEnterMode = 'launch' | 'send' | 'none';

/**
 * Spec #2897 ST-4 (REQ-3/REQ-4) — the DERIVED model-audio phase the launcher bar
 * renders. Never stored: `deriveModelAudioPhase` maps the host's signals onto it
 * each render. `'stopped'` is deliberately observationally identical to `'idle'`
 * (the indicator is removed and the resting placeholder returns), so the
 * derivation collapses it to `'idle'`; it is named here because it is a state of
 * the machine the user passes through (stop → no indicator, never a stale chip).
 */
export type ModelAudioPhase =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'processing'
  | 'stopped'
  | 'error';

/**
 * Spec #2897 ST-4 (UI/UX §4) — model-audio copy. The state is ALWAYS carried by
 * text (never colour/animation alone); the processing `Spinner` is decoration.
 */
export const MODEL_AUDIO_LISTENING_CHIP_COPY = 'Fredo is listening';
export const MODEL_AUDIO_LISTENING_PLACEHOLDER = 'Fredo is listening…';
export const MODEL_AUDIO_PROCESSING_CHIP_COPY = 'Fredo is processing your speech…';
export const MODEL_AUDIO_PROCESSING_PLACEHOLDER = 'Fredo is processing…';
/** Live-region lines (transitions only, exactly once each). */
export const MODEL_AUDIO_LISTENING_ANNOUNCEMENT = 'Fredo is listening';
export const MODEL_AUDIO_PROCESSING_ANNOUNCEMENT = 'Fredo is processing your speech';

/**
 * Spec #2897 ST-5 (REQ-6) — how long before the pinned bound the listening chip
 * starts counting down. A pure UI lead time (recognition over recall); it is NOT
 * the bound itself, which always comes from the backend constant.
 */
export const MODEL_AUDIO_WARN_S = 10;

/**
 * Spec #2897 ST-5 (REQ-6) — the below-bar limit notice's live-region line,
 * announced ONCE on the auto-stop transition. The visible notice carries the real
 * bound; this sentence is the AT channel.
 */
export const MODEL_AUDIO_LIMIT_ANNOUNCEMENT =
  'Recording limit reached. Fredo has your recording.';

/**
 * Spec #2897 ST-5 (REQ-6) — the pinned bound in whole seconds, derived from the
 * backend's `stt:state.limitMs`. `null` when the wire carries no bound (every
 * legacy / `'local'` path), so the caller can omit the number rather than invent
 * one.
 */
export function modelAudioLimitSeconds(limitMs: number | null | undefined): number | null {
  if (typeof limitMs !== 'number' || !Number.isFinite(limitMs) || limitMs <= 0) return null;
  return Math.round(limitMs / 1000);
}

/**
 * Spec #2897 ST-5 (REQ-6) — whole seconds left at the bound, never negative.
 * Pure, so the countdown arithmetic is unit-pinned without a clock.
 */
export function modelAudioSecondsLeft(elapsedMs: number, limitMs: number): number {
  return Math.max(0, Math.ceil((limitMs - elapsedMs) / 1000));
}

/** Spec #2897 ST-5 — the listening chip, with the countdown appended in the warning window. */
export function modelAudioListeningChipCopy(secondsLeft: number | null): string {
  return secondsLeft === null
    ? MODEL_AUDIO_LISTENING_CHIP_COPY
    : `${MODEL_AUDIO_LISTENING_CHIP_COPY} · ${secondsLeft}s left`;
}

/**
 * Spec #2897 ST-5 (REQ-6) — the polite below-bar limit notice, in the REAL bound
 * (derived from the backend constant). With no bound on the wire the sentence
 * still reads truthfully, without a fabricated number.
 */
export function modelAudioLimitNoticeCopy(limitSeconds: number | null): string {
  const bound = limitSeconds === null ? '' : ` ${limitSeconds}-second`;
  return `That's the${bound} limit — Fredo has your recording and is responding.`;
}

/**
 * Spec #2897 ST-4 — the PURE `ModelAudioPhase` derivation (UI/UX §4). It is the
 * ONE place the model-audio state is decided, so the indicator cannot drift from
 * the signals ST-2 exposes on `useVoiceDictation`:
 *
 *   local mode          → `'idle'` (the shipped transcription cue is untouched —
 *                          this derivation never fires for `'local'`);
 *   typed error         → `'error'` (the below-bar `role="alert"`);
 *   `processing`        → the stop delivered the clip; the backend is interpreting;
 *   `listening`         → capture live (`listening && origin === 'launcher'`);
 *   `starting`          → the shipped bounded `starting voice input…` window;
 *   otherwise           → `'idle'` (includes `'stopped'`: indicator removed).
 */
export function deriveModelAudioPhase(input: {
  voiceMode: 'local' | 'model';
  /** `captureLive` — the launcher-origin capture is genuinely live. */
  listening: boolean;
  /** ST-2's `voice.modelAudioPhase` (backend `stt:state.phase`). */
  modelAudioPhase: VoiceModelAudioPhase | null;
  /** The shipped bounded starting window (`startingChip`). */
  starting: boolean;
  /** A typed failure is being surfaced (`voiceErrorMessage !== null`). */
  error: boolean;
}): ModelAudioPhase {
  if (input.voiceMode !== 'model') return 'idle';
  if (input.error) return 'error';
  if (input.modelAudioPhase === 'processing') return 'processing';
  if (input.listening) return 'listening';
  if (input.starting) return 'starting';
  return 'idle';
}

/**
 * #2892 ST-5 — the queued indicator's element id, referenced by the searchbox
 * `aria-describedby` only while the indicator is actually rendered.
 */
export const QUEUED_INDICATOR_ID = 'fredo-command-queued';

/**
 * #2892 ST-5 — the queue drain-edge announcement (UI/UX §5, bound literal). The
 * visible indicator is deliberately NOT a live region; this hidden polite region
 * is the ONE AT channel for the queue, and it fires on transitions only.
 */
export const QUEUED_DISPATCH_ANNOUNCEMENT = 'Sending your queued message to Fredo';

/**
 * Spec #2887 ST-5 (R-3/AC3) — the BINDING honest hold-cue contract.
 *
 *   'none'        → no cue (idle / promise / non-empty field / voice unavailable)
 *   'acknowledge' → the non-listening acknowledgement (from the keydown edge):
 *                   `Hold to dictate…` in the field; no dot, no accent tint
 *   'starting'    → the bounded `starting voice input…` chip (engine-resident slow
 *                   start, bounded by `T_MAX_STARTING_STATE_MS`) + the acknowledgement
 *   'warming'     → the launch-window acknowledgement (engine NOT resident: the hold
 *                   joined — or started — the single-flight warm; bounded by
 *                   `T_LAUNCH_COLD_MAX_MS` = 5320 ms = `T_LAUNCH_WARM_MS.max`
 *                   + `T_FIRST_CAPTURE_BUDGET_MS.max`, i.e. ONE model load plus the
 *                   capture budget). It
 *                   shares the shipped bounded chip because that is the only honest
 *                   "what is actually happening" copy UI/UX specified for a
 *                   non-listening start — and it never says `Listening`.
 *   'listening'   → the ONLY state that may render the `Listening` chip, the
 *                   `Listening…` placeholder, the accent dot/border tint, the
 *                   Stop/`×` controls or the listening announcement
 *
 * Invariant (R-3): `'listening'` is reachable ONLY while `captureLive` (the
 * `listening` prop = `voice.listening && origin === 'launcher'`, `LauncherShell.tsx`).
 * `holdArmed`/`holdPending` alone MUST NOT claim listening, and `'warming'`/
 * `'starting'`/`'acknowledge'` are never rendered as the listening cue.
 */
export type HoldCue = 'none' | 'acknowledge' | 'starting' | 'warming' | 'listening';

export interface LauncherCommandBarProps {
  /** Live query string (controlled by the host). */
  query: string;
  /** Reports every query change up to the host (the host filters the grid). */
  onQueryChange: (q: string) => void;
  /** Whether the launcher grid is open — drives `aria-expanded`. */
  gridOpen?: boolean;
  /** Active grid tile id during grid roving-tabindex focus — drives `aria-activedescendant`. */
  ariaActivedescendant?: string;
  /** Reached-engaged signal: the input received focus (#2819 — host reveals the grid). */
  onFocus?: () => void;
  /** Leaves-engaged signal: the input lost focus (#2819 — the host guards focus-within). */
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  /** The `—` minimize control was clicked (#2819 — host collapses the shell to bare chrome). */
  onMinimize?: () => void;
  /** #2871: pending Enter action — drives the prefix glyph swap. Defaults to `'launch'`. */
  enterMode?: LauncherEnterMode;
  /** #2871: full hint-chip text (host-derived); absent/empty → no chip. */
  hintLabel?: string;
  /**
   * #2871; #2892 ST-5 re-scoped — a reply GENERATION is in flight (the host feeds
   * `replyInFlight`, NOT `isInUse`). Holds `aria-busy` + the accent indicator and
   * selects the `Fredo is replying…` placeholder. It NEVER sets `readOnly`
   * (AC1): the field stays editable in every reply state, so hovering a finished
   * reply (which keeps `isInUse` true) cannot make typing impossible.
   */
  busy?: boolean;
  /**
   * #2892 ST-5 (AC5) — the count of accepted sends awaiting dispatch (0 = none).
   * While ≥ 1 the bar renders the quiet waiting indicator in the below-bar status
   * slot (`launcher-command-queued`) with ST-3's `queuedWaitingCopy`, and the
   * hidden `launcher-queued-announcer` announces queue transitions. Defaults to
   * `0`, so the inactive bar is byte-identical (AC4).
   */
  queuedCount?: number;
  /**
   * Spec #2877 ST-5 (DR-7) — the launcher-origin listening cue. `true` while a
   * `launcher`-origin dictation session owns the bar: swaps the placeholder to
   * `Listening…`, tints the border with `tint('var(--accent-primary)', 30)`
   * (token-native, no hardcoded color) and shows the static indicator + the
   * `Listening` chip + the Stop control. The host gates this to
   * `origin === 'launcher'` so exactly ONE indicator shows per session (R-5.3).
   * Defaults to `false` — the bar then renders EXACTLY as before
   * (inactive-companion invariance).
   */
  listening?: boolean;
  /**
   * Spec #2887 ST-5 (R-3) — the host-derived honest cue (see `HoldCue`). When
   * supplied it is authoritative; the bar clamps `'listening'` to a live capture
   * (`listening`), so no caller can make it claim listening early. The host gates
   * the `'starting'`/`'warming'` windows (ST-7). Defaults to the legacy derivation
   * below so the shipped #2882 caller keeps working.
   */
  cue?: HoldCue;
  /**
   * Spec #2882 ST-5 (R-2.4); superseded by `cue` (Spec #2887 ST-5). A HOLD is
   * armed: the qualifying Space keydown happened and the bounded threshold timer
   * is running. It maps to `'acknowledge'` — the `Hold to dictate…` placeholder
   * from this moment for the WHOLE gesture, so the state is never silent while
   * Space is held, and it NEVER claims listening (the #2882 defect this spec
   * fixes). Defaults to `false`.
   */
  holdArmed?: boolean;
  /**
   * Spec #2882 ST-5 (UI/UX §1 S2); superseded by `cue` (Spec #2887 ST-5). The hold
   * crossed the 200 ms threshold and the engine is not live yet: it maps to
   * `'starting'` — the bounded `starting voice input…` chip, shown only once the
   * pending window outlives `HOLD_PENDING_CUE_MS` (the host owns that gate). It
   * occupies the SAME end slot as the `Listening` chip (never both). Defaults to
   * `false`.
   */
  holdPending?: boolean;
  /**
   * Spec #2882 ST-5 (R-2.1 / contract 4c) — holding Space would dictate right now
   * (voice enabled + FAIL-CLOSED model readiness + not busy). Drives the S1
   * promise placeholder; with readiness unknown NO promise is made, so the bar
   * falls back to the legacy `search or command`.
   */
  holdAvailable?: boolean;
  /** DR-7: stops the live session (the bar's Stop control). This is the
   *  FINALIZE/commit control (`stt_stop`) — never re-point it at `stt_cancel`. */
  onStopListening?: () => void;
  /**
   * #2878 ST-2 (AC3 resolution) — the visible cancel/discard affordance for a
   * mouse user. It calls `cancel()` (`stt_cancel`: discard the in-flight
   * partial) and never launches/sends; Escape already discards. Optional and
   * rendered only while `listening`, so the inactive bar is byte-identical.
   */
  onCancelListening?: () => void;
  /**
   * #2878 ST-2 (UX-2) — the user manually edited the bar during a live segment.
   * The host stops further *partial* writes for the session (finals still
   * append). Reported only while `listening`; optional.
   */
  onUserEdit?: () => void;
  /**
   * DR-7/DR-11: curated `role="alert"` copy for a failed `stt_start`, or null.
   * The raw backend detail is never the primary sentence.
   */
  voiceErrorMessage?: string | null;
  /** DR-10: the newest FINAL transcript segment (partials never set this). */
  finalTranscript?: string;
  /**
   * DR-9/DR-10: voice input enablement. Drives the `Voice input is off`
   * announcement when it flips OFF mid-session. #2882 ST-4: it NO LONGER gates
   * `aria-keyshortcuts` — that attribute is now an unconditional
   * `Control+Space` (it advertises the bar-opening chord, not dictation).
   */
  voiceEnabled?: boolean;
  /**
   * Spec #2887 follow-up (UI/UX §4 S4) — the host's CANCEL signal: a monotonic
   * counter the HOST bumps when an Escape / `×` discards a GENUINELY LIVE
   * (`captureLive`) session. The bar's live region is transition-driven, so it
   * announces `Dictation cancelled` on the bump and SUPPRESSES the
   * `Stopped listening` line for that cancel (S4 must not read as S3). The host
   * bumps it ONLY for a live-session cancel, so an Escape that disarms a
   * pre-capture hold stays silent (UI/UX §3 flow 6: nothing claimed Listening,
   * so there is nothing to retract). Optional: omitted ⇒ the shipped
   * `Stopped listening` behaviour (inactive-bar invariance).
   */
  cancelSignal?: number;
  /** #2871 a11y (REQ-15/DR-6): accessible name for the searchbox (host-derived). */
  ariaLabel?: string;
  /**
   * #2871 a11y (REQ-15/DR-6): id of the visually-hidden hint mirror referenced by
   * the searchbox `aria-describedby`. The element mirrors the visible chip text.
   */
  ariaDescribedBy?: string;
  /**
   * #2883 ST-1 (R-1.4/R-1.5) — the companion is active, so the host reports that
   * `Shift+Enter` is available as a newline affordance. Gates the VISIBLE
   * `Shift+Enter adds a new line` caption, which renders only when the field is
   * also wrapped to ≥2 visual lines (restraint: short content never grows a
   * status row). The hidden newline sentence is static and does not depend on it.
   * Defaults to `false` — then the caption is never rendered.
   */
  newlineHint?: boolean;
  /**
   * #2883 ST-1 — the bar root element, exposed so the launcher can measure the
   * reply band (bar top / collapse control) with one `ResizeObserver` instead of
   * polling. Optional and inert when omitted.
   */
  containerRef?: React.Ref<HTMLDivElement>;
  /**
   * Spec #2897 ST-4 (REQ-3/REQ-4) — the persisted speech-handling mode. `'local'`
   * (default) renders the shipped transcription cue EXACTLY as before; `'model'`
   * swaps the capture cue for the model-audio indicator (`deriveModelAudioPhase`)
   * with ZERO transcript text. Omitted ⇒ `'local'` (byte-identical rendering).
   */
  voiceMode?: 'local' | 'model';
  /**
   * Spec #2897 ST-4 — ST-2's `voice.modelAudioPhase` (the backend
   * `stt:state.phase`): `'capturing'` while the clip accumulates, `'processing'`
   * once a stop committed it, `null` on every legacy/local path. It is consumed
   * by `deriveModelAudioPhase`; the bar never re-derives it from scratch.
   */
  modelAudioPhase?: VoiceModelAudioPhase | null;
  /**
   * Spec #2897 ST-5 (REQ-6) — ST-2's `voice.limitReached`: the capture
   * auto-stopped at the pinned ceiling and the whole clip is being interpreted.
   * A NORMAL terminal capture state rendered as a `var(--status-warning)` notice
   * in the below-bar slot (never `role="alert"`). Defaults to `false`, so the
   * inactive/quiet bar is byte-identical (AC4).
   */
  limitReached?: boolean;
  /**
   * Spec #2897 ST-5 (REQ-6) — the pinned per-input ceiling in ms (the backend
   * `stt:state.limitMs`). The last-N-seconds countdown and the limit notice copy
   * derive from THIS value, so backend and UI copy can never disagree; `null`
   * (default) renders neither.
   */
  modelAudioLimitMs?: number | null;
}

/**
 * Reserved right gutter while the hint chip shows: the chip's max width
 * (`HINT_CHIP_MAX_WIDTH_PX`) plus the end-slot chrome to its right — the
 * minimize control's left margin/border/padding and its 12px `—` glyph.
 * A CSS unit string (G-146) so it is pixels, never a Chakra size token.
 *
 * #2882 ST-4 (UI/UX §9): raised 184 → 220 so the longest truthful instruction
 * (`↵ send transcript to Fredo`) never ellipsizes — a truncated instruction is
 * a lying instruction (R-6.3).
 */
const HINT_CHIP_MAX_WIDTH_PX = 220;
/** Static `Listening` chip width (12px text) + the Stop control's footprint.
 *  CSS unit strings only (G-146 → exact pixels). */
const LISTENING_CHIP_WIDTH_PX = 72;
/**
 * Spec #2897 ST-4/ST-5 — the model-audio chip reservations. The listening chip
 * (`Fredo is listening`, and `Fredo is listening · 10s left` in the countdown
 * window) and the processing chip (`Fredo is processing your speech…`, plus its
 * decorative `Spinner`) are wider than the shipped 72px `Listening` chip, so the
 * end-slot gutter is sized to whichever one renders — the typed text can never
 * run under the indicator, and the countdown is never ellipsized away (a bound
 * the user cannot read is not a disclosed bound).
 */
const MODEL_AUDIO_LISTENING_CHIP_WIDTH_PX = 208;
const MODEL_AUDIO_PROCESSING_CHIP_WIDTH_PX = 248;
/** #2878 ST-2 — the cancel/discard control's gutter (24px + `ml="6px"`). */
const CANCEL_GUTTER_PX = 30;
const STOP_GUTTER_PX = 30;
/** The `—` MINIMIZE gutter: left margin/border/padding + the 12px glyph. */
const MINIMIZE_GUTTER_PX = 44;

/**
 * #2883 ST-1 (AC1) — the field's bound geometry. Every value is a plain number so
 * the arithmetic is unit-pinned; consumers append the `px` unit (G-146).
 *
 * Base `48px` is TODAY's rendered (border-box) height, unchanged. The field is a
 * native `<textarea>` under the Chakra preflight's `box-sizing: border-box`, so a
 * rendered height of `20n + 28` splits into `20n` content + `2 × 13px` padding +
 * `2 × 1px` border on top/bottom. The visible inset (13 + 1) is the design's 14 px,
 * which is why the padding constant is 13 and not 14: with 14 px the one-line box
 * would have to be 50 px tall, and a 48 px box would clip the line and report
 * `scrollHeight > clientHeight` (R-5.3's "no scrollbar" pin).
 */
export const BAR_FIELD_MIN_H_PX = 48;
export const BAR_FIELD_MAX_H_PX = 108;
export const BAR_FIELD_LINE_H_PX = 20;
/** `1px solid` on each vertical edge — added back to the measured content height. */
const BAR_FIELD_BORDER_PX = 1;
/** The design's 14 px visual inset minus the 1 px border. */
const BAR_FIELD_V_PADDING_PX = 14 - BAR_FIELD_BORDER_PX;
/**
 * The `>` chevron's leading gutter, supplied EXPLICITLY because `InputGroup`
 * injects `ps: calc(var(--input-height) - 0px)` and `--input-height` is defined
 * ONLY by the input recipe — on a `Textarea` child that declaration is
 * invalid-at-computed-value-time (→ 0), which would start the query/placeholder
 * under the chevron (and the end slot) (see the #2883 ST-1 Domain Model note).
 */
export const BAR_LEADING_GUTTER_PX = 40;
/**
 * #2883 ST-1 (a11y) — the STATIC hidden sentence appended inside the existing
 * `fredo-command-hint-sr` mirror, describing the multiline field to AT.
 */
export const NEWLINE_HINT_COPY = 'Shift+Enter starts a new line.';
/**
 * #2883 ST-1 (UI/UX §1) — the CONTEXTUAL visible caption, shown only when the
 * field is wrapped (≥2 visual lines) and the companion is active. Enter's own
 * wording stays owned by #2882.
 */
export const NEWLINE_CAPTION_COPY = 'Shift+Enter adds a new line';

/**
 * #2883 ST-1 (R-1.1/R-1.3) — the pure growth rule: the field's measured content
 * height (`scrollHeight`, which spans the padding box) → its border-box height,
 * clamped to `[BAR_FIELD_MIN_H_PX, BAR_FIELD_MAX_H_PX]`.
 *
 * Identity in the middle (one content line ⇒ one bound height), clamp at both
 * ends: below the cap the field grows by exactly one line step; above it the
 * height freezes at the cap and the field scrolls internally.
 */
export function measureFieldHeightPx(contentHeightPx: number): number {
  if (!Number.isFinite(contentHeightPx)) return BAR_FIELD_MIN_H_PX;
  const borderBox = Math.round(contentHeightPx) + BAR_FIELD_BORDER_PX * 2;
  return Math.min(BAR_FIELD_MAX_H_PX, Math.max(BAR_FIELD_MIN_H_PX, borderBox));
}

/** Visual line count implied by the (clamped) field height — ≥1 always. */
function visualLinesForHeightPx(fieldHeightPx: number): number {
  const content = fieldHeightPx - BAR_FIELD_V_PADDING_PX * 2 - BAR_FIELD_BORDER_PX * 2;
  return Math.max(1, Math.round(content / BAR_FIELD_LINE_H_PX));
}

/**
 * #2878 ST-2 — the reserved right gutter (px) for every end-slot affordance that
 * is present, so the typed text never renders underneath them. Exported as a
 * pure helper so the "zero reserved padding when nothing shows" invariance is
 * unit-pinned. `undefined` = omit the padding entirely (byte-identical idle bar).
 *
 * #2883 ST-1 (R-1.2) — the divider + `—` MINIMIZE control is rendered in EVERY
 * state, so any text or caret in the field must clear its 44px footprint. The
 * `hasText` input (the host's `query.length > 0`) reserves it while the bar holds
 * ANY character — the defect this closes is precisely the state where no chip
 * shows and the helper returned `undefined`, leaving the always-present control
 * with no gutter. `undefined` is kept ONLY for the truly empty bar (nothing
 * shows AND no text), which is today's pinned behaviour.
 */
export function computeEndPaddingPx(options: {
  showHint: boolean;
  listening: boolean;
  /**
   * Spec #2882 ST-5 (UI/UX §9) — the S2 pending chip occupies the SAME slot (and
   * the SAME width) as the Listening chip, so typed text never runs under it. It
   * is never rendered while `listening` (the slot is exclusive).
   */
  holdPending?: boolean;
  /**
   * #2883 ST-1 (R-1.2) — the field holds text (`query.length > 0`), so the
   * always-present divider + MINIMIZE control must be reserved even when no chip
   * shows. A whitespace-only / newline-only query is text (a caret can sit after
   * it), so it reserves the 44px gutter too.
   */
  hasText?: boolean;
  /**
   * Spec #2897 ST-4 — the derived model-audio phase (see `deriveModelAudioPhase`).
   * In `'listening'` the model chip + the Cancel/Stop controls are reserved; in
   * `'processing'` the (wider) processing chip is reserved and NO controls are
   * (nothing is left to cancel). Omitted/`'idle'` ⇒ the shipped arithmetic.
   */
  modelPhase?: ModelAudioPhase;
}): number | undefined {
  const modelListening = options.modelPhase === 'listening';
  const modelProcessing = options.modelPhase === 'processing';
  // The bounded hold chip occupies the SAME slot as the capture chips and is
  // never rendered while one of them is up (exactly ONE indicator).
  const pendingChip =
    !options.listening && !modelListening && !modelProcessing && options.holdPending === true;
  // The chip slot holds AT MOST ONE chip: the shipped `Listening` chip (local
  // mode), the model listening chip, the model processing chip, or the bounded
  // pending chip — never together.
  const chipPx = modelListening
    ? MODEL_AUDIO_LISTENING_CHIP_WIDTH_PX
    : modelProcessing
      ? MODEL_AUDIO_PROCESSING_CHIP_WIDTH_PX
      : options.listening
        ? LISTENING_CHIP_WIDTH_PX
        : pendingChip
          ? LISTENING_CHIP_WIDTH_PX
          : 0;
  // Cancel + Stop render only while a capture is live (both modes). `processing`
  // deliberately has none.
  const controlPx = options.listening || modelListening ? CANCEL_GUTTER_PX + STOP_GUTTER_PX : 0;
  const showsAnything = options.showHint || chipPx > 0 || controlPx > 0;
  const reserveMinimize = showsAnything || options.hasText === true;
  const px =
    (options.showHint ? HINT_CHIP_MAX_WIDTH_PX : 0) +
    chipPx +
    controlPx +
    (reserveMinimize ? MINIMIZE_GUTTER_PX : 0);
  return px > 0 ? px : undefined;
}

/** DR-7 — the "we haven't heard anything yet" hint, after this silent stretch. */
export const HEARING_NOTHING_MS = 6000;
export const HEARING_NOTHING_COPY =
  "Listening… we haven't heard anything yet — check that your microphone isn't muted.";

/**
 * Spec #2882 ST-5 (UI/UX §1 S2) — the bounded pending chip's copy. Shown only
 * once the engine start outlives `HOLD_PENDING_CUE_MS` (the host owns that gate),
 * so the loop never looks dead while the model/engine loads.
 */
export const STARTING_VOICE_INPUT_COPY = 'starting voice input…';

/**
 * Spec #2887 follow-up (UI/UX §4) — the COLD-path live-region announcement,
 * fired the moment the bounded `starting voice input…` chip renders (the
 * readying window outlived `HOLD_PENDING_CUE_MS` from threshold-crossed) and
 * BEFORE capture is live. The warm path never renders the chip, so it never
 * hears this line — exactly one `Listening` announcement, nothing before
 * capture. The S1 `Hold to dictate…` acknowledgement is TEXT in the field, never
 * a live-region announcement (it would double-speak within ≲100 ms).
 */
export const STARTING_VOICE_INPUT_ANNOUNCEMENT = 'Starting voice input';

/**
 * Spec #2887 follow-up (UI/UX §4 S4) — the CANCEL announcement, fired when the
 * host reports a live-session cancel (`cancelSignal`). It REPLACES the S3
 * `Stopped listening` line for that transition: a discarded utterance is never
 * reported as a finished one.
 */
export const DICTATION_CANCELLED_ANNOUNCEMENT = 'Dictation cancelled';

/**
 * Spec #2887 ST-5 (UI/UX §1 S1) — the pre-capture acknowledgement placeholder.
 * It describes the user's OWN gesture ("hold to dictate"), so it can never be
 * mistaken for capture and can never read as a stall. It replaces the shipped
 * `Listening…` for the armed/pending window — the honesty defect #2887 fixes
 * (`Listening`/`Listening…` are reserved for a genuinely live capture, S2).
 */
export const HOLD_ACKNOWLEDGE_PLACEHOLDER = 'Hold to dictate…';

/**
 * Spec #2882 ST-5 (UI/UX §1 S1) — the promise placeholder shown while the bar is
 * focused and empty and holding Space WOULD dictate (voice on + model ready + not
 * busy). Readiness unknown ⇒ this is never shown (contract 4c: no promise made).
 */
export const HOLD_AVAILABLE_PLACEHOLDER = 'search, or hold Space to dictate';

/** Accent `>` chevron prefix (monoweight, currentColor) — launch/filter mode. */
function ChevronGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Speech-bubble outline prefix (currentColor) — send-to-Fredo mode. */
function SpeechGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M3.5 9.5H3a1.5 1.5 0 0 1-1.5-1.5V3.5A1.5 1.5 0 0 1 3 2h6a1.5 1.5 0 0 1 1.5 1.5V8a1.5 1.5 0 0 1-1.5 1.5H6L4 11Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Wireframe `—` MINIMIZE dash (a short horizontal bar, muted `currentColor`). */
function MinusGlyph() {
  return (
    <Box as="span" width="12px" height="1.5px" borderRadius="1px" bg="currentColor" aria-hidden="true" />
  );
}

/** `×` discard glyph for the listening cancel control (currentColor, token-native). */
function CancelGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Filled square Stop glyph for the listening Stop control (currentColor). */
function StopGlyph() {
  return (
    <Box
      as="span"
      width="10px"
      height="10px"
      borderRadius="2px"
      bg="currentColor"
      aria-hidden="true"
    />
  );
}

export function LauncherCommandBar({
  query,
  onQueryChange,
  gridOpen = false,
  ariaActivedescendant,
  onFocus,
  onBlur,
  onMinimize,  enterMode = 'launch',
  hintLabel,
  busy = false,
  queuedCount = 0,
  listening = false,
  cue,
  holdArmed = false,
  holdPending = false,
  holdAvailable = false,
  onStopListening,
  onCancelListening,
  onUserEdit,
  voiceErrorMessage,
  finalTranscript = '',
  voiceEnabled = false,
  cancelSignal = 0,
  ariaLabel,
  ariaDescribedBy,
  newlineHint = false,
  containerRef,
  voiceMode = 'local',
  modelAudioPhase = null,
  limitReached = false,
  modelAudioLimitMs = null,
}: LauncherCommandBarProps) {
  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    // #2878 ST-2 (UX-2) — a user keystroke during a live segment makes the edit
    // authoritative: the host stops further partial writes for the session.
    // `onChange` fires only for real user input (never for a programmatic value
    // update), so this is exactly the manual-edit signal. #2883 ST-1: the field
    // is a `<textarea>` now, so a native `Shift+Enter` insertion lands here too.
    if (listening) onUserEdit?.();
    onQueryChange(e.target.value);
  };

  // #2883 ST-1 (R-1.1/R-1.3) — the field measures ITSELF and grows to fit its own
  // content. One rAF-coalesced layout read per frame (never per token/keystroke):
  // the pending frame id is the coalescing key, so a burst of keystrokes reads
  // `scrollHeight` once. State is written ONLY when the clamped height changes —
  // the AGENTS.md #523 loop guard (no write per render, no array/object dep).
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const [fieldHeightPx, setFieldHeightPx] = useState<number>(BAR_FIELD_MIN_H_PX);

  const scheduleFieldMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return;
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      const el = fieldRef.current;
      if (!el) return;
      // #2883 round 2 (D-1) — read the INTRINSIC content height, never the
      // constrained box. Per the CSSOM `scrollHeight` is `max(clientHeight,
      // contentExtent)`, so while the growth clamp below is applied the read can
      // never fall below the box: a cleared field reported 106 and
      // `measureFieldHeightPx(106)` mapped back to the 108px cap, making the
      // ladder one-way (growth worked, shrink was unreachable). Release the
      // applied height for THIS read only — `height: auto` lets the class
      // `min-height: 48px` / `max-height: 108px` bounds stand, so taller content
      // is still reported above the box (growth is unchanged) — then restore the
      // saved value verbatim so no other inline height is disturbed. Still one
      // layout read per frame and a state write only on a real change (#523).
      const appliedHeight = el.style.height;
      el.style.height = 'auto';
      const intrinsic = el.scrollHeight;
      el.style.height = appliedHeight;
      const next = measureFieldHeightPx(intrinsic);
      setFieldHeightPx((prev) => (prev === next ? prev : next));
    });
  }, []);

  // Re-measure whenever the controlled query changes (typing, dictation partials,
  // a host-side set/clear) and on any window resize (the wrap width changed).
  useEffect(() => {
    scheduleFieldMeasure();
  }, [query, scheduleFieldMeasure]);
  useEffect(() => {
    window.addEventListener('resize', scheduleFieldMeasure);
    return () => {
      window.removeEventListener('resize', scheduleFieldMeasure);
      if (measureFrameRef.current !== null) {
        window.cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
    };
  }, [scheduleFieldMeasure]);

  // The field grows in whole line steps and freezes at the cap (UI/UX §1 S0/S1/S2).
  const fieldAtCap = fieldHeightPx >= BAR_FIELD_MAX_H_PX;
  const visualLines = visualLinesForHeightPx(fieldHeightPx);

  // Primitive-keyed derivation (AGENTS.md #523) — never a fresh object/array dep.
  // #2882 ST-4 (R-6.3 / UI/UX §3): chip visibility is LABEL-DRIVEN — the host
  // derives the label from the SAME Enter verdict the handler consumes, so the
  // chip can never promise a different action than Enter performs. The old
  // `chatAvailable` term (which hid the truthful `↵ open <App>` / `no match`
  // chips whenever no companion was present) is retired with its prop.
  const showHint = useMemo(() => Boolean(hintLabel), [hintLabel]);

  // Spec #2887 ST-5 (R-3/AC3) — THE ONE CUE, and it may never lie.
  //
  // `holdCue` is the binding honesty contract. The armed window (`'acknowledge'`)
  // and the bounded start window (`'starting'` / the launch-window `'warming'`) are
  // non-listening acknowledgements; `'listening'` is reachable ONLY while
  // `captureLive` (the `listening` prop). The clamp below is what fixes the shipped
  // #2882 defect: `holdArmed` is true from the KEYDOWN (before any capture exists),
  // so it can no longer select the `Listening…` placeholder.
  const captureLive = listening;
  const requestedCue: HoldCue =
    cue ?? (holdPending ? 'starting' : holdArmed ? 'acknowledge' : 'none');
  const holdCue: HoldCue = captureLive
    ? 'listening'
    : requestedCue === 'listening'
      ? 'acknowledge' // an upstream `'listening'` without a live capture never claims listening
      : requestedCue;
  // The pre-capture acknowledgement states — no listening wording, no capture mark.
  const cueReadying =
    holdCue === 'acknowledge' || holdCue === 'starting' || holdCue === 'warming';
  // The CHIP slot holds at most one indicator: the bounded `starting voice input…`
  // chip and the Listening chip are mutually exclusive (never both). The
  // launch-window `warming` state shares the shipped chip — the only honest
  // "what is actually happening" copy UI/UX specified for a non-listening start —
  // and it never says `Listening`.
  const startingChip = (holdCue === 'starting' || holdCue === 'warming') && !captureLive;

  // Spec #2897 ST-4 (REQ-3/REQ-4) — the DERIVED model-audio phase. Local mode is
  // `'idle'` by construction, so the shipped transcription cue is untouched. Read
  // off ST-2's signals (never re-derived): `modelAudioPhase` is the backend's
  // `stt:state.phase`, `listening` is the live capture, and the bounded hold
  // window is the shipped `startingChip`. `'stopped'` collapses to `'idle'` (the
  // indicator is removed and the resting placeholder returns — no stale chip).
  const isModelVoice = voiceMode === 'model';
  const modelPhase = deriveModelAudioPhase({
    voiceMode,
    listening,
    modelAudioPhase,
    starting: startingChip,
    error: Boolean(voiceErrorMessage),
  });
  const modelListening = modelPhase === 'listening';
  const modelProcessing = modelPhase === 'processing';

  // Spec #2897 ST-5 (REQ-6) — the last-`MODEL_AUDIO_WARN_S`-seconds countdown on
  // the listening chip. The ticker starts only INSIDE the warning window (bounded
  // state writes: 4/s for ≤ 10 s, never for the whole capture) and derives the
  // remaining time from the ONE backend bound (`stt:state.limitMs`) — no
  // hardcoded duration. A session transition (auto-stop → `processing`) clears it,
  // so no timer outlives the capture. Primitive deps only (AGENTS.md #523).
  const limitSeconds = modelAudioLimitSeconds(modelAudioLimitMs);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!modelListening || modelAudioLimitMs === null) {
      setSecondsLeft(null);
      return;
    }
    const startedAt = Date.now();
    const warnAtMs = Math.max(0, modelAudioLimitMs - MODEL_AUDIO_WARN_S * 1000);
    let interval: number | null = null;
    const tick = () =>
      setSecondsLeft(modelAudioSecondsLeft(Date.now() - startedAt, modelAudioLimitMs));
    const first = window.setTimeout(() => {
      tick();
      interval = window.setInterval(tick, 250);
    }, warnAtMs);
    return () => {
      window.clearTimeout(first);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [modelListening, modelAudioLimitMs]);

  // S1 vs S0 (UI/UX §1): the promise placeholder is offered only while the search
  // input actually holds focus, is empty, and holding Space would dictate.
  const [inputFocused, setInputFocused] = useState(false);
  const handleInputFocus = () => {
    setInputFocused(true);
    onFocus?.();
  };
  const handleInputBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    setInputFocused(false);
    // The `onBlur` prop keeps its SHIPPED signature (the host's handler and its
    // `handleSurfaceBlur` chain are typed for `HTMLInputElement`; ST-2 owns that
    // file). The event payload the host consumes (`relatedTarget` containment,
    // the surface's own focus handling) is tag-agnostic at runtime.
    onBlur?.(e as unknown as React.FocusEvent<HTMLInputElement>);
  };

  // The placeholder (UI/UX §9): busy > the LIVE capture > the pre-capture
  // acknowledgement > the S1 promise > the legacy resting copy. Only `captureLive`
  // may produce `Listening…` (R-3); the armed/pending windows say `Hold to dictate…`.
  // Spec #2897 ST-4: in model mode the capture placeholder is `Fredo is listening…`
  // and the interpreting window is `Fredo is processing…` (never `Listening…` —
  // model audio opens no recogniser, so a `Listening…` claim would imply words).
  const placeholder = busy
    ? 'Fredo is replying…'
    : isModelVoice
      ? modelListening
        ? MODEL_AUDIO_LISTENING_PLACEHOLDER
        : modelProcessing
          ? MODEL_AUDIO_PROCESSING_PLACEHOLDER
          : cueReadying
            ? HOLD_ACKNOWLEDGE_PLACEHOLDER
            : holdAvailable && inputFocused && query === ''
              ? HOLD_AVAILABLE_PLACEHOLDER
              : 'search or command'
      : captureLive
        ? 'Listening…'
        : cueReadying
          ? HOLD_ACKNOWLEDGE_PLACEHOLDER
          : holdAvailable && inputFocused && query === ''
            ? HOLD_AVAILABLE_PLACEHOLDER
            : 'search or command';

  // #2877 ST-5 (DR-7) / #2878 ST-2 / #2883 ST-1 (R-1.2): reserve the right gutter
  // for every end-slot affordance that is present, so the typed text never renders
  // underneath them. With the hint chip this is `220 + 44 = 264px`; with text and
  // no chip it is the always-present MINIMIZE footprint (`44`); NOTHING showing AND
  // no text ⇒ omitted entirely (the truly empty bar keeps its shipped rendering).
  const endPaddingPx = computeEndPaddingPx({
    showHint,
    listening,
    holdPending: startingChip,
    hasText: query.length > 0,
    modelPhase,
  });
  const paddingEnd = endPaddingPx === undefined ? undefined : `${endPaddingPx}px`;

  // #2877 ST-5 (DR-7): the hearing-nothing hint — shown only after
  // `HEARING_NOTHING_MS` of a live session with an empty bar; it clears the
  // moment any text (partial or typed) arrives. Non-blocking, never auto-stops.
  const [hearingNothing, setHearingNothing] = useState(false);
  useEffect(() => {
    if (!listening || query.trim() !== '') {
      setHearingNothing(false);
      return;
    }
    const timer = setTimeout(() => setHearingNothing(true), HEARING_NOTHING_MS);
    return () => clearTimeout(timer);
  }, [listening, query]);

  // #2877 ST-5 (DR-10): the listening announcer flips ONLY on a transition —
  // never per event, never per partial. A disable-mid-session wins over the
  // subsequent `Stopped listening` (the sticky `voiceOffRef`) so the region
  // reads exactly once per user-visible transition.
  //
  // Spec #2887 follow-up (UI/UX §4): the SAME transition-driven machine now
  // carries the two missing transitions —
  //   • COLD path: `Starting voice input` the moment the bounded
  //     `starting voice input…` chip renders (the readying window outlived
  //     `HOLD_PENDING_CUE_MS`), then `Listening` once capture is genuinely live.
  //     The WARM path never renders the chip, so it announces exactly one line
  //     (`Listening`) and nothing before capture.
  //   • CANCEL (S4): `Dictation cancelled` on the host's `cancelSignal` bump,
  //     with the subsequent `Stopped listening` suppressed — a discarded
  //     utterance is never reported as a finished one.
  const [listenAnnouncement, setListenAnnouncement] = useState('');
  const prevListeningRef = useRef(listening);
  const prevVoiceEnabledRef = useRef(voiceEnabled);
  const voiceOffRef = useRef(false);
  // Set by the cancel effect and consumed by the listening effect in the SAME
  // commit when the host batches `cancelSignal` with `listening:false`.
  const cancelPendingRef = useRef(false);

  // COLD path (UI/UX §4): announce the bounded chip ONCE, on its rise edge. The
  // S1 `acknowledge` state renders no chip and is deliberately NOT announced.
  const prevStartingChipRef = useRef(startingChip);
  useEffect(() => {
    const was = prevStartingChipRef.current;
    prevStartingChipRef.current = startingChip;
    if (startingChip && !was) setListenAnnouncement(STARTING_VOICE_INPUT_ANNOUNCEMENT);
  }, [startingChip]);

  // CANCEL (S4). Declared BEFORE the listening effect so the flag is already set
  // when that effect inspects the same commit. The host bumps `cancelSignal`
  // only for a genuinely live cancel, so no listening check is needed here — and
  // an armed-window disarm (no bump) stays silent by construction.
  const prevCancelSignalRef = useRef(cancelSignal);
  useEffect(() => {
    const was = prevCancelSignalRef.current;
    prevCancelSignalRef.current = cancelSignal;
    if (cancelSignal === was) return;
    cancelPendingRef.current = true;
    setListenAnnouncement(DICTATION_CANCELLED_ANNOUNCEMENT);
  }, [cancelSignal]);

  useEffect(() => {
    const was = prevListeningRef.current;
    prevListeningRef.current = listening;
    if (was === listening) return;
    if (listening) {
      // A fresh capture clears every prior transition's sticky state.
      cancelPendingRef.current = false;
      voiceOffRef.current = false;
    }
    // S4 — a cancel already announced `Dictation cancelled`; never follow it
    // with the S3 stop line for the same transition.
    if (!listening && cancelPendingRef.current) {
      cancelPendingRef.current = false;
      return;
    }
    if (!listening && voiceOffRef.current) return;
    if (listening) {
      // Spec #2897 ST-4 — in model mode the capture is an audio capture, so the
      // announcement names it exactly (`Fredo is listening`); the shipped
      // transcription line stays for local mode.
      setListenAnnouncement(isModelVoice ? MODEL_AUDIO_LISTENING_ANNOUNCEMENT : 'Listening');
      return;
    }
    // Falling edge. Spec #2897 ST-4 — a model-audio STOP hands over to the
    // `processing` window, whose own rise edge announces (`Fredo is processing
    // your speech`); one stop must never announce twice.
    if (isModelVoice && modelAudioPhase === 'processing') return;
    setListenAnnouncement('Stopped listening');
  }, [listening, isModelVoice, modelAudioPhase]);

  // Spec #2897 ST-4 (UI/UX §4) — the `processing` rise edge, announced ONCE.
  // Declared AFTER the listening effect so that on the stop commit (listening
  // false + phase `processing`) this line is the one the region reads. It is
  // model-mode only: local mode never has a backend `processing` phase.
  const prevModelAudioPhaseRef = useRef<VoiceModelAudioPhase | null>(modelAudioPhase);
  useEffect(() => {
    const was = prevModelAudioPhaseRef.current;
    prevModelAudioPhaseRef.current = modelAudioPhase;
    if (!isModelVoice) return;
    if (modelAudioPhase === 'processing' && was !== 'processing') {
      setListenAnnouncement(MODEL_AUDIO_PROCESSING_ANNOUNCEMENT);
    }
  }, [modelAudioPhase, isModelVoice]);

  // Spec #2897 ST-5 (REQ-6) — the auto-stop bound, announced ONCE on the
  // `limitReached` rise. Declared AFTER the processing effect so that on the
  // auto-stop commit (capture ends + `processing` + `limitReached` in ONE state
  // event) this is the line the region reads — the bound is the news, not the
  // hand-over. It never re-announces on a later re-render or the user's release.
  const prevLimitReachedRef = useRef(limitReached);
  useEffect(() => {
    const was = prevLimitReachedRef.current;
    prevLimitReachedRef.current = limitReached;
    if (isModelVoice && limitReached && !was) {
      setListenAnnouncement(MODEL_AUDIO_LIMIT_ANNOUNCEMENT);
    }
  }, [limitReached, isModelVoice]);

  useEffect(() => {
    const was = prevVoiceEnabledRef.current;
    prevVoiceEnabledRef.current = voiceEnabled;
    if (was && !voiceEnabled) {
      voiceOffRef.current = true;
      setListenAnnouncement('Voice input is off');
    }
  }, [voiceEnabled]);

  const isAlert = Boolean(voiceErrorMessage);
  // Spec #2897 ST-5 (REQ-6) — the auto-stop's polite below-bar notice. It is a
  // WARNING (never `role="alert"`) and carries the REAL bound from the backend
  // constant. The below-bar slot precedence becomes: alert (voice error) >
  // model-audio limit > hearing-nothing > queued > newline caption.
  const modelLimitMessage =
    isModelVoice && limitReached ? modelAudioLimitNoticeCopy(limitSeconds) : null;
  // The error takes precedence over every other line; the limit notice in turn
  // outranks the hearing-nothing hint (an auto-stopped capture is not "silent").
  const statusMessage =
    voiceErrorMessage ??
    (modelLimitMessage === null && listening && hearingNothing ? HEARING_NOTHING_COPY : null);
  const showModelLimit = modelLimitMessage !== null && statusMessage === null;

  // #2892 ST-5 (AC5) — the queued waiting indicator. The below-bar slot shows at
  // most ONE message; the precedence is alert (voice error) > model-audio limit >
  // hearing-nothing > queued > newline caption. The indicator is therefore
  // suppressed whenever `statusMessage` (or the limit notice) is present, and it
  // in turn suppresses the `Shift+Enter` caption (`showNewlineCaption` requires
  // `queuedCount === 0`). It outranks the key-hint caption because a pending send
  // matters more than a keyboard hint.
  const showQueued = queuedCount >= 1 && !statusMessage && !showModelLimit;

  // #2883 ST-1 (UI/UX §1 / R-1.4) — the CONTEXTUAL `Shift+Enter` caption. It is
  // rendered ONLY when the host reports the companion active AND the field is
  // actually wrapped (≥2 visual lines): short or empty content never grows a
  // status row (restraint NFR, AC5's second half). Precedence in the status slot:
  // alert (voice error) > model-audio limit > hearing-nothing > queued > newline
  // caption — so the caption never displaces a live message, and Enter's own
  // wording (#2882) is untouched.
  const showNewlineCaption =
    newlineHint &&
    visualLines >= 2 &&
    !statusMessage &&
    !showModelLimit &&
    queuedCount === 0;

  // #2892 ST-5 (a11y) — compose the searchbox `aria-describedby` from the targets
  // ACTUALLY rendered: the hint mirror (only while the chip shows AND the host
  // supplied its id) and/or the queued indicator. Undefined when neither renders,
  // so no dangling id is ever referenced.
  const describedBy =
    [
      showHint && ariaDescribedBy ? ariaDescribedBy : null,
      showQueued ? QUEUED_INDICATOR_ID : null,
    ]
      .filter((id): id is string => Boolean(id))
      .join(' ') || undefined;

  // #2892 ST-5 — the queue announcer is TRANSITION-driven, never per event. Rise
  // 0→n and decrease n→m (m≥1) announce the waiting copy for the NEW count; the
  // drain edge →0 announces the dispatch sentence. A no-change re-render is silent.
  const [queuedAnnouncement, setQueuedAnnouncement] = useState('');
  const prevQueuedCountRef = useRef(queuedCount);
  useEffect(() => {
    const was = prevQueuedCountRef.current;
    prevQueuedCountRef.current = queuedCount;
    if (queuedCount > was) {
      setQueuedAnnouncement(queuedWaitingCopy(queuedCount));
    } else if (queuedCount < was) {
      setQueuedAnnouncement(
        queuedCount >= 1 ? queuedWaitingCopy(queuedCount) : QUEUED_DISPATCH_ANNOUNCEMENT,
      );
    }
  }, [queuedCount]);

  return (
    <Box
      ref={containerRef}
      data-testid="launcher-command-bar"
      display="flex"
      flexDirection="column"
      alignItems="center"
      w="100%"
      px="4"
    >
      <InputGroup
        width="100%"
        maxWidth="560px"
        // `aria-busy` is omitted (not `"false"`) when idle so the inactive bar
        // stays byte-identical to today (AC4).
        aria-busy={busy || undefined}
        startElement={
          <Box
            as="span"
            color="accent.default"
            display="flex"
            alignItems="center"
            gap={busy || listening || modelProcessing ? '6px' : undefined}
            aria-hidden="true"
          >
            {enterMode === 'send' ? <SpeechGlyph /> : <ChevronGlyph />}
            {busy && (
              <Box
                as="span"
                data-testid="launcher-command-busy"
                width="6px"
                height="6px"
                borderRadius="full"
                bg="accent.default"
                flexShrink={0}
              />
            )}
            {/* #2877 ST-5 (DR-7) — FROZEN static listening dot (no pulse/loop).
                Spec #2897 ST-4 — the SAME dot marks the model-audio capture AND
                the interpreting window (`processing`), so the indicator is
                continuous from capture through interpretation. */}
            {(listening || modelProcessing) && (
              <Box
                as="span"
                data-testid="launcher-command-listening"
                width="6px"
                height="6px"
                borderRadius="full"
                bg="accent.default"
                flexShrink={0}
              />
            )}
          </Box>
        }
        endElement={
          <Box display="flex" alignItems="center" height="100%">
            {/* Spec #2882 ST-5 (UI/UX §1 S2/§9) — the bounded pending chip: the
                hold crossed the threshold but the engine is not live yet. It is a
                clone of the Listening chip (same box, same slot) and the two are
                never rendered together (exactly ONE indicator). */}
            {startingChip && !modelProcessing && (
              <Box
                as="span"
                data-testid="launcher-command-listening-pending"
                display="block"
                height="24px"
                lineHeight="24px"
                px="8px"
                borderRadius="4px"
                bg="accent.subtle"
                color="fg.default"
                fontFamily="var(--font-primary)"
                fontSize="12px"
                whiteSpace="nowrap"
                flexShrink={0}
              >
                {STARTING_VOICE_INPUT_COPY}
              </Box>
            )}
            {/* #2877 ST-5 (DR-7) — visible `Listening` chip + Stop control, before
                the existing hint chip / divider / `—` minimize (which stays LAST).
                Spec #2897 ST-4 — `'local'` mode ONLY; model mode renders its own
                chip below (never the transcription wording). */}
            {listening && !isModelVoice && (
              <Box
                as="span"
                data-testid="launcher-command-listening-chip"
                display="block"
                height="24px"
                lineHeight="24px"
                px="8px"
                borderRadius="4px"
                bg="accent.subtle"
                color="fg.default"
                fontFamily="var(--font-primary)"
                fontSize="12px"
                whiteSpace="nowrap"
                flexShrink={0}
              >
                Listening
              </Box>
            )}
            {/* Spec #2897 ST-4 (UI/UX §4, REQ-3) — the MODEL-AUDIO capture chip.
                Text carries the state; the mode-agnostic dot above is the mark.
                It occupies the SAME single chip slot as the local Listening chip
                (never both). */}
            {modelListening && (
              <Box
                as="span"
                data-testid="launcher-command-model-listening-chip"
                display="block"
                height="24px"
                lineHeight="24px"
                px="8px"
                borderRadius="4px"
                bg="accent.subtle"
                color="fg.default"
                fontFamily="var(--font-primary)"
                fontSize="12px"
                whiteSpace="nowrap"
                maxWidth={`${MODEL_AUDIO_LISTENING_CHIP_WIDTH_PX}px`}
                overflow="hidden"
                textOverflow="ellipsis"
                flexShrink={0}
              >
                {modelAudioListeningChipCopy(secondsLeft)}
              </Box>
            )}
            {/* Spec #2897 ST-4 (UI/UX §4, REQ-4) — the interpreting window: the
                stop delivered the clip and the backend is responding to it. The
                `Spinner` is decoration only (the text carries the state) so
                `prefers-reduced-motion` changes nothing about the meaning, and NO
                Stop/Cancel renders (there is nothing left to cancel). */}
            {modelProcessing && (
              <Box
                as="span"
                data-testid="launcher-command-model-processing-chip"
                display="flex"
                alignItems="center"
                gap="6px"
                height="24px"
                lineHeight="24px"
                px="8px"
                borderRadius="4px"
                bg="accent.subtle"
                color="fg.default"
                fontFamily="var(--font-primary)"
                fontSize="12px"
                whiteSpace="nowrap"
                maxWidth={`${MODEL_AUDIO_PROCESSING_CHIP_WIDTH_PX}px`}
                overflow="hidden"
                flexShrink={0}
              >
                <Spinner size="xs" color="accent.default" aria-hidden="true" />
                <Box as="span" overflow="hidden" textOverflow="ellipsis">
                  {MODEL_AUDIO_PROCESSING_CHIP_COPY}
                </Box>
              </Box>
            )}
            {/* #2878 ST-2 (AC3 resolution) — the visible CANCEL/DISCARD affordance
                (`stt_cancel`): Escape already discards; this exposes the same
                gesture to a mouse user. It never launches/sends — only the commit
                step does. The Stop control below stays the FINALIZE/commit path. */}
            {listening && onCancelListening && (
              <Box
                as="button"
                data-testid="launcher-command-listening-cancel"
                aria-label="Cancel dictation"
                onClick={onCancelListening}
                onMouseDown={(e) => e.preventDefault()}
                display="flex"
                alignItems="center"
                justifyContent="center"
                height="24px"
                width="24px"
                ml="6px"
                borderRadius="4px"
                color="var(--text-secondary)"
                cursor="pointer"
                flexShrink={0}
                _hover={{ color: 'var(--status-error)' }}
                css={{
                  '&:focus-visible': { outline: '2px solid var(--accent-primary)', outlineOffset: '2px' },
                }}
              >
                <CancelGlyph />
              </Box>
            )}
            {listening && onStopListening && (
              <Box
                as="button"
                data-testid="launcher-command-listening-stop"
                aria-label="Stop listening"
                onClick={onStopListening}
                onMouseDown={(e) => e.preventDefault()}
                display="flex"
                alignItems="center"
                justifyContent="center"
                height="24px"
                width="24px"
                ml="6px"
                borderRadius="4px"
                color="var(--text-secondary)"
                cursor="pointer"
                flexShrink={0}
                _hover={{ color: 'accent.default' }}
                css={{
                  '&:focus-visible': { outline: '2px solid var(--accent-primary)', outlineOffset: '2px' },
                }}
              >
                <StopGlyph />
              </Box>
            )}
            {showHint && (
              <Box
                as="span"
                data-testid="launcher-command-hint"
                display="block"
                maxWidth={`${HINT_CHIP_MAX_WIDTH_PX}px`}
                height="24px"
                lineHeight="24px"
                px="8px"
                borderRadius="4px"
                bg="accent.subtle"
                color="fg.default"
                fontFamily="var(--font-primary)"
                fontSize="12px"
                whiteSpace="nowrap"
                overflow="hidden"
                textOverflow="ellipsis"
                flexShrink={0}
              >
                {hintLabel}
              </Box>
            )}
            <Box
              as="button"
              aria-label="Minimize launcher"
              onClick={onMinimize}
              onMouseDown={(e) => e.preventDefault()}
              display="flex"
              alignItems="center"
              height="100%"
              pl="10px"
              ml="10px"
              borderLeft="1px solid"
              borderLeftColor="var(--border-color)"
              color="var(--text-secondary)"
              cursor={onMinimize ? 'pointer' : 'default'}
              _hover={onMinimize ? { color: 'accent.default' } : undefined}
              css={{
                '&:focus-visible': { outline: '2px solid var(--accent-primary)', outlineOffset: '2px' },
              }}
            >
              <MinusGlyph />
            </Box>
          </Box>
        }
      >
        <Textarea
          ref={fieldRef}
          data-testid="launcher-command-input"
          // #2883 ST-1 (a11y) — the element is a native `<textarea>` but the ROLE
          // is unchanged, so every #2882 selector/predicate (`SEARCHBOX_SELECTOR`
          // in LauncherShell, the hold-Space target predicate, `isFromInput`)
          // stays tag-agnostic; `aria-multiline` carries the multiline semantics.
          role="searchbox"
          aria-multiline="true"
          aria-label={ariaLabel ?? 'Search or command'}
          aria-expanded={gridOpen}
          aria-controls="fredo-launcher-grid"
          aria-activedescendant={ariaActivedescendant}
          // #2892 ST-5 — composed from the targets ACTUALLY rendered (hint mirror
          // and/or the queued indicator); omitted entirely when neither renders.
          aria-describedby={describedBy}
          // #2882 ST-4 (UI/UX §8): the chord ALWAYS opens/focuses the bar, so the
          // shortcut is advertised unconditionally — it is no longer a voice
          // affordance (the hold-Space long-press is not expressible in ARIA; the
          // armed mirror sentence carries it).
          aria-keyshortcuts="Control+Space"
          placeholder={placeholder}
          // #2892 ST-5 (AC1) — DELETED `readOnly={busy}`: no reply state may
          // disable the field. Streaming, hovered-complete and queued states all
          // keep the caret and typing available ("keep composing").
          value={query}
          onChange={handleChange}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          // #2883 ST-1 — BOTH paddings are supplied EXPLICITLY, and they are
          // supplied as BOTH the longhand (`paddingStart`/`paddingEnd`) and the
          // SHORTHAND `InputGroup` injects (`ps`/`pe`).
          //
          // The trap (traced + unit-probed, NOT hypothetical): `InputGroup` clones
          // its child with `{...endElement && {pe: 'calc(var(--input-height) - 0px)'}, ...children.props}`
          // (`input-group.js:38-45`) and `--input-height` is defined ONLY by the
          // INPUT recipe — on this `<textarea>` the injected `calc()` is
          // invalid-at-computed-value-time (→ 0). Overriding it needs the SAME key:
          // `...children.props` is spread last, so a child-supplied `ps`/`pe`
          // replaces the injected value, while a longhand `paddingStart`/`paddingEnd`
          // maps to the same canonical property and does NOT displace it (emotion
          // keeps the LAST assertion in prop order — the injected shorthand). Both
          // keys carry the same value here, so the result is identical either way.
          // The leading 40px replaces the input recipe's md `--input-height`; the
          // end gutter is the computed reservation (omitted only for the truly
          // empty bar — `undefined` means neither key is rendered).
          ps={`${BAR_LEADING_GUTTER_PX}px`}
          pe={paddingEnd}
          paddingStart={`${BAR_LEADING_GUTTER_PX}px`}
          paddingEnd={paddingEnd}
          // The field is a wrapping content box: `20n + 28px` border-box for
          // 1..4 visual lines (48/68/88/108), then frozen at the cap with an
          // internal scroll. No CSS height transition (a transition would re-wrap
          // the text every frame — the performance NFR) and no `scrollbar-gutter`.
          rows={1}
          lineHeight={`${BAR_FIELD_LINE_H_PX}px`}
          paddingTop={`${BAR_FIELD_V_PADDING_PX}px`}
          paddingBottom={`${BAR_FIELD_V_PADDING_PX}px`}
          minHeight={`${BAR_FIELD_MIN_H_PX}px`}
          maxHeight={`${BAR_FIELD_MAX_H_PX}px`}
          height={`${fieldHeightPx}px`}
          resize="none"
          overflowX="hidden"
          // Scrolling is enabled ONLY at the cap; below it the field is exactly as
          // tall as its content, so `scrollHeight === clientHeight` (R-5.3).
          overflowY={fieldAtCap ? 'auto' : 'hidden'}
          // A 200-char URL must never overflow sideways or push text under the
          // end slot — it breaks instead.
          overflowWrap="break-word"
          bg="var(--card-bg)"
          border="1px solid"
          borderColor={listening ? tint('var(--accent-primary)', 30) : 'var(--border-color)'}
          borderRadius="8px"
          fontFamily="var(--font-primary)"
          fontSize="14px"
          fontWeight="regular"
          color="fg.default"
          _placeholder={{ color: 'fg.muted' }}
          _hover={{ borderColor: 'var(--accent-primary)' }}
          _focus={{
            borderColor: 'var(--accent-primary)',
            boxShadow: 'none',
            outline: 'none',
          }}
          _focusVisible={{
            borderColor: 'var(--accent-primary)',
            boxShadow: 'none',
            outline: '2px solid var(--accent-primary)',
            outlineOffset: '2px',
          }}
          // #2883 ST-1 — the cap's internal scroller reuses the launcher's existing
          // rail (`LauncherShell.tsx:1466-1470`: 8px thumb `var(--card-hover-bg)`,
          // transparent track) so the bar never shows a browser-default scrollbar
          // and needs NO new colour token.
          css={{
            '&::-webkit-scrollbar': { width: '8px', height: '8px' },
            '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
          }}
        />
      </InputGroup>
      {/* #2871 a11y (REQ-15/DR-6) — the visually-hidden mirror the searchbox
          `aria-describedby` points at; it mirrors the visible chip text exactly
          so AT gets the pending-Enter action without a second live region.
          Rendered only while the chip shows (no chip → no description).
          #2883 ST-1 (a11y): the STATIC newline sentence is appended INSIDE this
          same mirror, so the searchbox keeps its shipped `aria-describedby` value
          (`fredo-command-hint`) and no second describedby target is introduced. */}
      {showHint && ariaDescribedBy && (
        <Box
          id={ariaDescribedBy}
          data-testid="fredo-command-hint-sr"
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
          {hintLabel}
          {` ${NEWLINE_HINT_COPY}`}
        </Box>
      )}
      {/* #2877 ST-5 (DR-7/DR-11) — below the bar: the hearing-nothing hint, or an
          inline `role="alert"` carrying the curated start-failure copy. Mounted
          only while it has something to say (a live region that is empty when
          idle is not useful here; the dedicated announcers below are persistent). */}
      {statusMessage && (
        <Box
          data-testid="launcher-command-listening-status"
          role={isAlert ? 'alert' : undefined}
          aria-live={isAlert ? 'assertive' : 'polite'}
          mt="2"
          maxWidth="560px"
          textAlign="center"
          fontFamily="var(--font-primary)"
          fontSize="12px"
          color={isAlert ? 'var(--status-error)' : 'var(--text-subtle)'}
        >
          {statusMessage}
        </Box>
      )}
      {/* #2897 ST-5 (REQ-6) — the auto-stop LIMIT NOTICE, in the SAME status slot.
          Warning treatment (`var(--status-warning)`), deliberately NOT a live
          region and NOT `role="alert"`: reaching the bound is a normal terminal
          capture state, and the hidden `voice-listening-announcer` is the ONE AT
          channel (`Recording limit reached. Fredo has your recording.`), so AT is
          never told twice. Suppressed by a voice error (alert wins) and suppresses
          the hearing-nothing/queued/newline lines below. */}
      {showModelLimit && (
        <Box
          data-testid="launcher-command-model-limit-status"
          mt="2"
          maxWidth="560px"
          textAlign="center"
          fontFamily="var(--font-primary)"
          fontSize="12px"
          color="var(--status-warning)"
        >
          {modelLimitMessage}
        </Box>
      )}
      {/* #2892 ST-5 (AC5) — the queued waiting indicator: the SAME box metrics as
          the newline caption, plain text (NOT a live region — the hidden announcer
          is the one AT channel, avoiding double-speak). Rendered only while a
          message is queued AND no higher-priority status message occupies the
          slot; the id is referenced by `aria-describedby` only in that state. */}
      {showQueued && (
        <Box
          id={QUEUED_INDICATOR_ID}
          data-testid={QUEUED_WAITING_TESTID}
          mt="2"
          maxWidth="560px"
          textAlign="center"
          fontFamily="var(--font-primary)"
          fontSize="12px"
          color="var(--text-subtle)"
        >
          {queuedWaitingCopy(queuedCount)}
        </Box>
      )}
      {/* #2883 ST-1 (R-1.4) — the CONTEXTUAL newline caption, in the SAME status
          slot (identical `mt`/`maxWidth`/centring/type ramp) and only while the
          field is wrapped with the companion active. It is plain text (no live
          region): the growing bar itself is silent to AT, and the static sentence
          reaches AT through the `fredo-command-hint-sr` mirror. A higher-priority
          status message or the queued indicator suppresses it, so the slot never
          shows two messages. */}
      {showNewlineCaption && (
        <Box
          data-testid="launcher-command-newline-caption"
          mt="2"
          maxWidth="560px"
          textAlign="center"
          fontFamily="var(--font-primary)"
          fontSize="12px"
          color="var(--text-subtle)"
        >
          {NEWLINE_CAPTION_COPY}
        </Box>
      )}
      {/* #2877 ST-5 (DR-10) — persistent polite live regions (always mounted, so
          AT registers them). Start/stop transitions only; partials never write
          the transcript region. */}
      <Box
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="voice-listening-announcer"
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
        {listenAnnouncement}
      </Box>
      <Box
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Transcribed text"
        data-testid="voice-transcript-announcer"
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
        {finalTranscript}
      </Box>
      {/* #2892 ST-5 (AC5) — the queued announcer: ALWAYS mounted (AT registers a
          persistent polite region) and transition-driven only. The visible
          indicator is not a live region, so the queue is spoken exactly once per
          transition and never on a plain re-render. */}
      <Box
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="launcher-queued-announcer"
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
        {queuedAnnouncement}
      </Box>
    </Box>
  );
}
