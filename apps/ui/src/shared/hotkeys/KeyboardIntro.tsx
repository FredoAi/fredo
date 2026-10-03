/**
 * Spec #2960 ST-4 — the non-modal first-run introduction + its persisted
 * dismissal (EARS R-5.1–R-5.4).
 *
 * Shown at most ONCE per profile: on mount the persisted intro-seen flag is
 * read (`introDismissal.ts`); while the read is unresolved NOTHING renders (no
 * flash of the wrong state, R-5.4); when it resolves unseen the compact card
 * introduces the interaction model and announces it once through the ONE shared
 * polite region (`announce()`, `announcer.tsx`); when it resolves seen the card
 * never renders.
 *
 * It is NOT a modal: no `role="dialog"`, no `aria-modal`, no focus trap, no
 * scrim, no onboarding wizard, no settings page. The visual body is
 * `aria-hidden`; the focusable `Got it` button is a SIBLING OUTSIDE that wrapper
 * so it stays in the accessibility tree and is keyboard-operable (R-5.3).
 *
 * Placement (ST-5): the card is IN-FLOW — it no longer self-positions. The ONE
 * shared `HotkeysCluster` owns `position: fixed; left; top; z-index` and stacks
 * the chip, the discovery control, and this card; the card's top inset is
 * therefore DERIVED by the cluster (G-253/G-267), never a nominal sum. The card
 * re-enables pointer events on its own subtree (the cluster is click-through).
 *
 * Render behaviour (G-273/G-274): the body is the ONE shrink target and WRAPS
 * within the card's bounded width (no horizontal clip); the `Got it` control is
 * EXEMPT from any shrink (`flexShrink={0}` + `whiteSpace="nowrap"`) so it renders
 * full-size and clickable at every supported width.
 *
 * Colour is theme-token / CSS-var / the shared `tint()` helper only — zero
 * hex/rgba/hsl, zero `var(--x)NN` alpha-append. Entrance motion is
 * opacity/transform only and is disabled under `prefers-reduced-motion`.
 */

import React, { useEffect, useState } from 'react';
import { Box, Button, Text } from '@chakra-ui/react';

import { Keycap } from '../components/hotkeys/Keycap';
import { tint } from '../utils/colorTint';
import { announce } from './announcer';
import { persistIntroSeen, readIntroSeen } from './introDismissal';
import { KEYBOARD_MODE_CHORD } from './keyboardMode';

// ── Contract testids (plan BINDING block — adopt verbatim) ───────────────────

/** The non-modal card root. */
export const KEYBOARD_INTRO_TESTID = 'hotkeys-intro';
/** The `aria-hidden` visual body (dismiss is a sibling OUTSIDE this wrapper). */
export const KEYBOARD_INTRO_BODY_TESTID = 'hotkeys-intro-body';
/** The focusable `Got it` dismiss control. */
export const KEYBOARD_INTRO_DISMISS_TESTID = 'hotkeys-intro-dismiss';

// ── Layout / motion constants ────────────────────────────────────────────────

/** The cluster's resting left offset (px) — matches the chip/discovery anchor. */
export const KEYBOARD_INTRO_LEFT_PX = 12;
/** The bounded card width (px) — the body WRAPS inside it (G-273). */
export const KEYBOARD_INTRO_MAX_WIDTH_PX = 320;
/** Same top-left cluster layer as the regime signal; below which-key/cheat-sheet. */
export const KEYBOARD_INTRO_Z_INDEX = 1310;
/** The entrance fade (≤300 ms) — skipped under `prefers-reduced-motion`. */
export const KEYBOARD_INTRO_FADE_MS = 180;
/** The ONE announcement copy, spoken through the shared polite region (R-5.1). */
export const KEYBOARD_INTRO_ANNOUNCEMENT =
  'Keyboard help. Type in a field and letters are text. Elsewhere keys run actions; open Keys to see them. Control Shift F8 turns on keyboard mode.';

const INTRO_KEYFRAMES = {
  '@keyframes hotkeys-intro-fade': {
    from: { opacity: 0, transform: 'translateY(-4px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
} as const;

const MOTION_STYLE: React.CSSProperties = {
  animation: `hotkeys-intro-fade ${KEYBOARD_INTRO_FADE_MS}ms ease`,
  transition: `opacity ${KEYBOARD_INTRO_FADE_MS}ms ease`,
};
const NO_MOTION_STYLE: React.CSSProperties = { animation: 'none', transition: 'none' };

/** `pending` until the persisted read settles; then `seen` | `unseen`. */
type IntroStatus = 'pending' | 'seen' | 'unseen';

/** Resolve the OS `prefers-reduced-motion` flag without adding a dependency. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

export interface KeyboardIntroProps {
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/**
 * The first-run card. Mounted ONCE by `HotkeysProvider` (ST-5). Renders `null`
 * while the persisted read is unresolved, once it is known seen, and after the
 * user dismisses it — it never reappears in the session or on a later mount.
 */
export function KeyboardIntro({
  reducedMotion,
}: KeyboardIntroProps = {}): React.ReactElement | null {
  const queryReduced = usePrefersReducedMotion();
  const reduceMotion = reducedMotion ?? queryReduced;

  const [status, setStatus] = useState<IntroStatus>('pending');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readIntroSeen()
      .then((seen) => {
        if (!cancelled) setStatus(seen ? 'seen' : 'unseen');
      })
      .catch(() => {
        // The settings channel never throws; a broken read must never nag the user.
        if (!cancelled) setStatus('seen');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = status === 'unseen' && !dismissed;

  // Announce exactly once, on the false→true visibility transition (R-5.1).
  useEffect(() => {
    if (!visible) return;
    announce(KEYBOARD_INTRO_ANNOUNCEMENT);
  }, [visible]);

  if (!visible) return null;

  const dismiss = (): void => {
    setDismissed(true);
    void persistIntroSeen();
  };

  return (
    <Box
      data-testid={KEYBOARD_INTRO_TESTID}
      css={INTRO_KEYFRAMES}
      style={{
        pointerEvents: 'auto',
        ...(reduceMotion ? NO_MOTION_STYLE : MOTION_STYLE),
      }}
      display="flex"
      alignItems="flex-start"
      gap="3"
      maxWidth={`${KEYBOARD_INTRO_MAX_WIDTH_PX}px`}
      paddingX="3"
      paddingY="2"
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="md"
      boxShadow="var(--shadow-dialog)"
    >
      {/* The visual body — aria-hidden; the shared announcer carries the speech. */}
      <Box
        data-testid={KEYBOARD_INTRO_BODY_TESTID}
        aria-hidden="true"
        flex="1"
        minWidth="0"
        display="flex"
        flexDirection="column"
        gap="1"
        whiteSpace="normal"
        overflowWrap="break-word"
      >
        <Text fontSize="xs" color="fg.default">
          Keyboard — type in a field: letters are text.
        </Text>
        <Text fontSize="xs" color="fg.muted">
          Elsewhere keys run actions — open{' '}
          <Text as="span" fontWeight="medium" color="fg.default">
            Keys
          </Text>{' '}
          to see them.
        </Text>
        <Text fontSize="xs" color="fg.muted" display="flex" alignItems="center" gap="1.5" flexWrap="wrap">
          <Keycap sequence={KEYBOARD_MODE_CHORD} />
          <Text as="span">turns on keyboard mode.</Text>
        </Text>
      </Box>

      {/* The dismiss control — a sibling OUTSIDE the aria-hidden wrapper so it
          stays AT-reachable, and EXEMPT from shrink (G-274). */}
      <Button
        data-testid={KEYBOARD_INTRO_DISMISS_TESTID}
        type="button"
        onClick={dismiss}
        flexShrink={0}
        whiteSpace="nowrap"
        size="xs"
        bg={tint('var(--accent-primary)', 14)}
        color="fg.default"
        borderWidth="1px"
        borderColor="border.default"
        borderRadius="sm"
        _hover={{ bg: tint('var(--accent-primary)', 22) }}
      >
        Got it
      </Button>
    </Box>
  );
}
