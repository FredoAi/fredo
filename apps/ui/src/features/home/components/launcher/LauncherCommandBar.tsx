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
 * #2882 ST-5 — the hold-Space cue (R-2.4):
 *   • `holdArmed` shows the cue from the KEYDOWN moment for the whole gesture
 *     (`Listening…`), so the state is never silent while Space is held;
 *   • `holdPending` (the host gates it on `HOLD_PENDING_CUE_MS`) adds the bounded
 *     `starting voice input…` chip (`launcher-command-listening-pending`) in the
 *     SAME slot as the Listening chip — the two are mutually exclusive, so exactly
 *     ONE indicator ever shows, and the reserved gutter accounts for whichever it is;
 *   • `holdAvailable` drives the S1 promise placeholder (`search, or hold Space to
 *     dictate`) — shown only while the input is focused and empty with a usable
 *     model, so no promise is made when Space is simply an ordinary space.
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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Box, Input, InputGroup } from '@chakra-ui/react';

import { tint } from '../../../../shared/utils/colorTint';

/** Pending Enter action, derived by the host (UI/UX §1); presentational only. */
export type LauncherEnterMode = 'launch' | 'send' | 'none';

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
   * Spec #2882 ST-5 (R-2.4) — a HOLD is armed: the qualifying Space keydown
   * happened and the bounded threshold timer is running. The bar shows the cue
   * from this moment for the WHOLE gesture (the `Listening…` placeholder), so the
   * state is never silent while Space is held. Defaults to `false`.
   */
  holdArmed?: boolean;
  /**
   * Spec #2882 ST-5 (UI/UX §1 S2) — the hold crossed the 200 ms threshold and the
   * engine is not live yet: the bounded `starting voice input…` pending chip,
   * shown only once the pending window outlives `HOLD_PENDING_CUE_MS` (the host
   * owns that gate). It occupies the SAME end slot as the `Listening` chip (never
   * both). Defaults to `false`.
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
 * #2878 ST-2 — the reserved right gutter (px) for every end-slot affordance that
 * is present, so the typed text never renders underneath them. Exported as a
 * pure helper so the "zero reserved padding when nothing shows" invariance is
 * unit-pinned. `undefined` = omit the padding entirely (byte-identical idle bar).
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
}): number | undefined {
  const pendingChip = !options.listening && options.holdPending === true;
  const px =
    (options.showHint ? HINT_CHIP_MAX_WIDTH_PX : 0) +
    (options.listening ? LISTENING_CHIP_WIDTH_PX + CANCEL_GUTTER_PX + STOP_GUTTER_PX : 0) +
    (pendingChip ? LISTENING_CHIP_WIDTH_PX : 0) +
    (options.showHint || options.listening || pendingChip ? MINIMIZE_GUTTER_PX : 0);
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
}: LauncherCommandBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    // #2878 ST-2 (UX-2) — a user keystroke during a live segment makes the edit
    // authoritative: the host stops further partial writes for the session.
    // `onChange` fires only for real user input (never for a programmatic value
    // update), so this is exactly the manual-edit signal.
    if (listening) onUserEdit?.();
    onQueryChange(e.target.value);
  };

  // Primitive-keyed derivation (AGENTS.md #523) — never a fresh object/array dep.
  // #2882 ST-4 (R-6.3 / UI/UX §3): chip visibility is LABEL-DRIVEN — the host
  // derives the label from the SAME Enter verdict the handler consumes, so the
  // chip can never promise a different action than Enter performs. The old
  // `chatAvailable` term (which hid the truthful `↵ open <App>` / `no match`
  // chips whenever no companion was present) is retired with its prop.
  const showHint = useMemo(() => Boolean(hintLabel), [hintLabel]);

  // Spec #2882 ST-5 (R-2.4) — THE ONE CUE. It is shown from the armed moment
  // (`holdArmed`), stays through the bounded pending window (`holdPending`) and
  // the live capture (`listening`), and is gone the moment the gesture is over.
  // The CHIP slot holds at most one indicator: the pending chip and the Listening
  // chip are mutually exclusive (never both).
  const cueActive = holdArmed || holdPending || listening;
  const pendingChip = holdPending && !listening;

  // S1 vs S0 (UI/UX §1): the promise placeholder is offered only while the search
  // input actually holds focus, is empty, and holding Space would dictate.
  const [inputFocused, setInputFocused] = useState(false);
  const handleInputFocus = () => {
    setInputFocused(true);
    onFocus?.();
  };
  const handleInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setInputFocused(false);
    onBlur?.(e);
  };

  // The 4-way placeholder (UI/UX §9): busy > the gesture cue > the S1 promise >
  // the legacy resting copy.
  const placeholder = busy
    ? 'Fredo is replying…'
    : cueActive
      ? 'Listening…'
      : holdAvailable && inputFocused && query === ''
        ? HOLD_AVAILABLE_PLACEHOLDER
        : 'search or command';

  // #2877 ST-5 (DR-7) / #2878 ST-2: reserve the right gutter for every end-slot
  // affordance that is present, so the typed text never renders underneath them.
  // With only the hint chip this is `220 + 44 = 264px`. Nothing present ⇒
  // omitted entirely.
  const endPaddingPx = computeEndPaddingPx({ showHint, listening, holdPending: pendingChip });
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

  return (
    <Box display="flex" flexDirection="column" alignItems="center" w="100%" px="4">
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
            {pendingChip && (
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
        <Input
          role="searchbox"
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
          paddingEnd={paddingEnd}
          bg="var(--card-bg)"
          border="1px solid"
          borderColor={listening ? tint('var(--accent-primary)', 30) : 'var(--border-color)'}
          borderRadius="8px"
          height="48px"
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
        />
      </InputGroup>
      {/* #2871 a11y (REQ-15/DR-6) — the visually-hidden mirror the searchbox
          `aria-describedby` points at; it mirrors the visible chip text exactly
          so AT gets the pending-Enter action without a second live region.
          Rendered only while the chip shows (no chip → no description). */}
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
