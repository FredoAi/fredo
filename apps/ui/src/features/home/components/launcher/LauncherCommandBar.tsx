/**
 * Fredo launcher command bar (Spec #2808 ST-3; #2871 ST-3 chat affordances).
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
 *     `[hint chip][vertical divider][— minimize]`; the chip is hidden only when
 *     `chatAvailable` is false or `hintLabel` is absent. The host derives the
 *     label per state (#2871 ST-2r: `launch`/`send` when idle, `Fredo is
 *     replying…` while busy), so the visibility rule is label-driven rather than
 *     `enterMode`-driven — state 5 (busy) has no pending Enter action yet still
 *     shows the chip. The `—` MINIMIZE control stays the LAST item in every state
 *     (its existing `borderLeft` is the vertical divider) and is never replaced.
 *     When the chip shows, the `Input` reserves `paddingEnd` so the typed text
 *     never runs under it.
 *   • State 5 (busy, UI/UX §1): the `Input` becomes `readOnly` and shows the
 *     `Fredo is replying…` placeholder; `aria-busy` + the accent indicator stay
 *     on for the whole stream.
 *
 * Inactive-companion invariance (AC4): every new prop is OPTIONAL and defaults to
 * today's rendering (`chatAvailable=false` / `enterMode='launch'` / no
 * `hintLabel` / `busy=false`) — no chip, no glyph swap, no reserved padding, and
 * `aria-busy` is omitted (not rendered as `"false"`), so the inactive bar is
 * byte-identical to before this change.
 *
 * Token-native contract (AC5): every color is a theme CSS var referenced
 * directly (`var(--card-bg)`, `var(--border-color)`, `var(--accent-primary)`),
 * a Chakra semantic token (`accent.default`, `accent.subtle`, `fg.default`,
 * `fg.muted`), or a shared `tint()` color-mix. There is NO hardcoded hex/rgba and
 * NO `var(--x)NN` alpha-append anywhere in this file.
 */

import { useMemo } from 'react';
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
  /** #2871: companion active in THIS window (host-derived; gates the hint chip). */
  chatAvailable?: boolean;
  /** #2871: pending Enter action — drives the prefix glyph swap. Defaults to `'launch'`. */
  enterMode?: LauncherEnterMode;
  /** #2871: full hint-chip text (host-derived); absent/empty → no chip. */
  hintLabel?: string;
  /** #2871: generation in flight — holds `aria-busy` + the accent indicator. */
  busy?: boolean;
  /**
   * SPIKE #2876 ST-4 (DR-1) — THROWAWAY listening cue. `true` while a dictation
   * session owns the bar: swaps the placeholder to `Listening…`, tints the
   * border with `tint('var(--accent-primary)', …)` (token-native, no hardcoded
   * color) and shows the transient indicator. Defaults to `false`, in which case
   * the bar renders EXACTLY as before (inactive-companion invariance).
   */
  listening?: boolean;
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
 */
const HINT_CHIP_MAX_WIDTH_PX = 184;
const HINT_PADDING_END = `${HINT_CHIP_MAX_WIDTH_PX + 44}px`;

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

export function LauncherCommandBar({
  query,
  onQueryChange,
  gridOpen = false,
  ariaActivedescendant,
  onFocus,
  onBlur,
  onMinimize,
  chatAvailable = false,
  enterMode = 'launch',
  hintLabel,
  busy = false,
  listening = false,
  ariaLabel,
  ariaDescribedBy,
}: LauncherCommandBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => onQueryChange(e.target.value);

  // Primitive-keyed derivation (AGENTS.md #523) — never a fresh object/array dep.
  // Label-driven visibility (#2871 ST-3r state 5): the host omits the label when
  // no chip should render, so busy still shows the host-supplied `Fredo is
  // replying…` label; while non-busy only `launch`/`send` yield a label, so that
  // behavior is unchanged.
  const showHint = useMemo(
    () => chatAvailable && Boolean(hintLabel),
    [chatAvailable, hintLabel],
  );

  return (
    <Box display="flex" justifyContent="center" w="100%" px="4">
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
            {/* SPIKE #2876 ST-4 (DR-1) — transient listening indicator. */}
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
          placeholder={busy ? 'Fredo is replying…' : listening ? 'Listening…' : 'search or command'}
          readOnly={busy}
          value={query}
          onChange={handleChange}
          onFocus={onFocus}
          onBlur={onBlur}
          paddingEnd={showHint ? HINT_PADDING_END : undefined}
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
    </Box>
  );
}
