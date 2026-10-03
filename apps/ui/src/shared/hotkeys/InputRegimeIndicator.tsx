/**
 * Spec #2960 ST-2 — the PERSISTENT input-regime chip (typing vs navigating).
 *
 * The two regimes must be legible at a glance and announced, never colour-only.
 * The chip derives its regime from the engine's ONE focus snapshot
 * (`useFocusSnapshot()`, ST-1) through the PURE `regimeForFocusSnapshot` — it
 * never re-derives `isTextControl`/`classifyFocusContext` itself, so the signal
 * can never disagree with `data-fredo-input-regime` on `document.body`.
 *
 * Three non-colour channels (R-1.3):
 *   1. a text LABEL — `Typing` / `Navigating` (`hotkeys-input-regime-label`);
 *   2. an icon SHAPE — `LuTextCursorInput` vs `LuNavigation` (asserted via root);
 *   3. a shape/outline distinction — typing `bg.subtle`+`border.subtle`
 *      (`borderRadius="sm"`); navigating `tint('var(--accent-primary)',14)`+
 *      `border.default` (`borderRadius="full"`).
 *
 * Read-only / non-intrusive (R-1.4): the root is `aria-hidden="true"` and
 * `pointerEvents: 'none'`, has no focusable descendant and declares NO live
 * region of its own — every announcement goes through the ONE shared
 * `announce()` channel (`announcer.tsx`), and ONLY on a regime transition (boot
 * does not announce).
 *
 * Placement (ST-5): the chip is IN-FLOW — it no longer self-positions. The ONE
 * shared `HotkeysCluster` owns `position: fixed; left; top; z-index` and stacks
 * the chip above the discovery control and the first-run card (G-253/G-267). The
 * chip only declares `pointerEvents: 'none'` (click-through) and `flexShrink: 0`.
 *
 * Render behaviour (G-273): the label is `flexShrink={0}` + `whiteSpace="nowrap"`
 * so it renders in full, never ellipsized or clipped.
 *
 * Colour is theme-token / CSS-var / the shared `tint()` helper only — zero
 * hex/rgba/hsl, zero `var(--x)NN` alpha-append. Any fade is disabled under
 * `prefers-reduced-motion`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Icon, Text } from '@chakra-ui/react';
import { LuKeyboard, LuNavigation, LuTextCursorInput } from 'react-icons/lu';

import { tint } from '../utils/colorTint';
import { announce } from './announcer';
import { useFocusSnapshot } from './engine';
import { inputRegimeAnnouncement, regimeForFocusSnapshot, type InputRegime } from './inputRegime';
import { useKeyboardMode } from './keyboardMode';

// ── Contract testids / attributes / stacking (plan BINDING block) ────────────

/** The chip root; carries `data-input-regime` (`'typing'|'navigating'`). */
export const INPUT_REGIME_TESTID = 'hotkeys-input-regime';
/** The text label — display unit `Typing` / `Navigating`. */
export const INPUT_REGIME_LABEL_TESTID = 'hotkeys-input-regime-label';
/** The `Keyboard mode` marker (renders iff navigating AND keyboard mode ON). */
export const INPUT_REGIME_MODE_TESTID = 'hotkeys-input-regime-mode';
/** The regime attribute on the chip root (mirrors the engine body hook). */
export const INPUT_REGIME_ATTR = 'data-input-regime';
/** Above launcher-open (1300); below which-key (1400) and cheat sheet (1500). */
export const REGIME_SIGNAL_Z_INDEX = 1310;

/** The mode marker's word (display unit of the S2 flag). */
export const INPUT_REGIME_MODE_TEXT = 'Keyboard mode';

// ── Motion (opacity only, ≤150 ms; suppressed under reduced motion) ──────────

const REGIME_FADE_MS = 150;

const FADE_KEYFRAMES = {
  '@keyframes hotkeys-input-regime-fade': {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
} as const;

const MOTION_STYLE: React.CSSProperties = {
  animation: `hotkeys-input-regime-fade ${REGIME_FADE_MS}ms ease`,
  transition: `opacity ${REGIME_FADE_MS}ms ease`,
};
const NO_MOTION_STYLE: React.CSSProperties = { animation: 'none', transition: 'none' };

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

export interface InputRegimeIndicatorProps {
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/**
 * The persistent top-left input-regime chip. Mounted ONCE by `HotkeysProvider`.
 * Renders `null` ONLY for the `terminal` context (the shipped terminal pill owns
 * that signal, R-2.4).
 */
export function InputRegimeIndicator({
  reducedMotion,
}: InputRegimeIndicatorProps = {}): React.ReactElement | null {
  const snapshot = useFocusSnapshot();
  const modeOn = useKeyboardMode();
  const queryReduced = usePrefersReducedMotion();
  const reduceMotion = reducedMotion ?? queryReduced;

  const regime = regimeForFocusSnapshot(snapshot);

  // Announce ONLY on a real regime transition. The mount-time regime is the
  // baseline, so boot never announces (R-1.2/R-2.2); `terminal` (null) is silent.
  const lastRegimeRef = useRef<InputRegime | null>(regime);
  useEffect(() => {
    const previous = lastRegimeRef.current;
    if (regime === previous) return;
    lastRegimeRef.current = regime;
    if (regime !== null) announce(inputRegimeAnnouncement(regime));
  }, [regime]);

  if (regime === null) return null;

  const typing = regime === 'typing';
  const RegimeIcon = typing ? LuTextCursorInput : LuNavigation;

  return (
    <Box
      data-testid={INPUT_REGIME_TESTID}
      data-input-regime={regime}
      aria-hidden="true"
      css={FADE_KEYFRAMES}
      style={{
        pointerEvents: 'none',
        flexShrink: 0,
        ...(reduceMotion ? NO_MOTION_STYLE : MOTION_STYLE),
      }}
      display="flex"
      alignItems="center"
      gap="1.5"
      paddingX="2"
      paddingY="1"
      borderWidth="1px"
      bg={typing ? 'bg.subtle' : tint('var(--accent-primary)', 14)}
      borderColor={typing ? 'border.subtle' : 'border.default'}
      borderRadius={typing ? 'sm' : 'full'}
    >
      <Icon as={RegimeIcon} boxSize="4" color={typing ? 'fg.muted' : 'accent.default'} />
      <Text
        data-testid={INPUT_REGIME_LABEL_TESTID}
        fontSize="sm"
        color="fg.default"
        fontWeight="medium"
        whiteSpace="nowrap"
        flexShrink={0}
      >
        {typing ? 'Typing' : 'Navigating'}
      </Text>
      {!typing && modeOn ? (
        <Box
          data-testid={INPUT_REGIME_MODE_TESTID}
          display="flex"
          alignItems="center"
          gap="1"
          paddingX="1.5"
          paddingY="0.5"
          borderRadius="sm"
          bg="bg.subtle"
          flexShrink={0}
        >
          <Icon as={LuKeyboard} boxSize="3.5" color="fg.muted" />
          <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap" flexShrink={0}>
            {INPUT_REGIME_MODE_TEXT}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
