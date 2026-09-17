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
 *     required animation).
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
 *   • State 5 (busy, UI/UX §1): the `Input` becomes `readOnly` and shows the
 *     `Fredo is replying…` placeholder; `aria-busy` + the accent indicator stay
 *     on for the whole stream.
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
 * Inactive-companion invariance (AC4): every new prop is OPTIONAL and defaults to
 * today's rendering (`enterMode='launch'` / no `hintLabel` / `busy=false` /
 * `listening=false` / no stop or cancel handler / no error / no final transcript
 * / `voiceEnabled=false`) — no chip, no glyph swap, no reserved padding, and
 * `aria-busy` is omitted (not rendered as `"false"`). #2882 ST-4 deliberately
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
import { Box, InputGroup, Textarea } from '@chakra-ui/react';

import { tint } from '../../../../shared/utils/colorTint';

/** Pending Enter action, derived by the host (UI/UX §1); presentational only. */
export type LauncherEnterMode = 'launch' | 'send' | 'none';

/**
 * Spec #2887 ST-5 (R-3/AC3) — the BINDING honest hold-cue contract.
 *
 *   'none'        → no cue (idle / promise / non-empty field / voice unavailable)
 *   'acknowledge' → the non-listening acknowledgement (from the keydown edge):
 *                   `Hold to dictate…` in the field; no dot, no accent tint
 *   'starting'    → the bounded `starting voice input…` chip (engine-resident slow
 *                   start, bounded by `T_MAX_STARTING_STATE_MS`) + the acknowledgement
 *   'warming'     → the launch-window acknowledgement (engine NOT resident: the hold
 *                   joined the in-flight warm; bounded by `T_LAUNCH_COLD_MAX_MS`). It
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
  /** #2871: generation in flight — holds `aria-busy` + the accent indicator. */
  busy?: boolean;
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
}): number | undefined {
  const pendingChip = !options.listening && options.holdPending === true;
  const showsAnything = options.showHint || options.listening || pendingChip;
  const reserveMinimize = showsAnything || options.hasText === true;
  const px =
    (options.showHint ? HINT_CHIP_MAX_WIDTH_PX : 0) +
    (options.listening ? LISTENING_CHIP_WIDTH_PX + CANCEL_GUTTER_PX + STOP_GUTTER_PX : 0) +
    (pendingChip ? LISTENING_CHIP_WIDTH_PX : 0) +
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
  ariaLabel,
  ariaDescribedBy,
  newlineHint = false,
  containerRef,
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
  const placeholder = busy
    ? 'Fredo is replying…'
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
  const [listenAnnouncement, setListenAnnouncement] = useState('');
  const prevListeningRef = useRef(listening);
  const prevVoiceEnabledRef = useRef(voiceEnabled);
  const voiceOffRef = useRef(false);

  useEffect(() => {
    const was = prevListeningRef.current;
    prevListeningRef.current = listening;
    if (was === listening) return;
    if (!listening && voiceOffRef.current) return;
    if (listening) voiceOffRef.current = false;
    setListenAnnouncement(listening ? 'Listening' : 'Stopped listening');
  }, [listening]);

  useEffect(() => {
    const was = prevVoiceEnabledRef.current;
    prevVoiceEnabledRef.current = voiceEnabled;
    if (was && !voiceEnabled) {
      voiceOffRef.current = true;
      setListenAnnouncement('Voice input is off');
    }
  }, [voiceEnabled]);

  const isAlert = Boolean(voiceErrorMessage);
  // The error takes precedence over the hearing-nothing hint (a failed start is
  // never `listening`, so they cannot normally coexist).
  const statusMessage =
    voiceErrorMessage ?? (listening && hearingNothing ? HEARING_NOTHING_COPY : null);

  // #2883 ST-1 (UI/UX §1 / R-1.4) — the CONTEXTUAL `Shift+Enter` caption. It is
  // rendered ONLY when the host reports the companion active AND the field is
  // actually wrapped (≥2 visual lines): short or empty content never grows a
  // status row (restraint NFR, AC5's second half). Precedence in the status slot:
  // alert (voice error) > hearing-nothing > newline caption — so the caption never
  // displaces a live message, and Enter's own wording (#2882) is untouched.
  const showNewlineCaption = newlineHint && visualLines >= 2 && !statusMessage;

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
            gap={busy || listening ? '6px' : undefined}
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
            {/* #2877 ST-5 (DR-7) — FROZEN static listening dot (no pulse/loop). */}
            {listening && (
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
            {startingChip && (
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
                the existing hint chip / divider / `—` minimize (which stays LAST). */}
            {listening && (
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
          aria-describedby={showHint ? ariaDescribedBy : undefined}
          // #2882 ST-4 (UI/UX §8): the chord ALWAYS opens/focuses the bar, so the
          // shortcut is advertised unconditionally — it is no longer a voice
          // affordance (the hold-Space long-press is not expressible in ARIA; the
          // armed mirror sentence carries it).
          aria-keyshortcuts="Control+Space"
          placeholder={placeholder}
          readOnly={busy}
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
      {/* #2883 ST-1 (R-1.4) — the CONTEXTUAL newline caption, in the SAME status
          slot (identical `mt`/`maxWidth`/centring/type ramp) and only while the
          field is wrapped with the companion active. It is plain text (no live
          region): the growing bar itself is silent to AT, and the static sentence
          reaches AT through the `fredo-command-hint-sr` mirror. A higher-priority
          status message suppresses it, so the slot never shows two messages. */}
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
    </Box>
  );
}
