/**
 * Spec #2958 ST-4 — the non-colour-only, change-triggered interaction-context
 * indicator (EARS R-4.1; the visual half of R-4.2 — the shared announcer speaks).
 *
 * The indicator renders ONLY when the active interaction context really CHANGES
 * (the `contextStack` snapshot identity advances). It is transient by design:
 * the pill remains visible for at least `CONTEXT_INDICATOR_DWELL_MS`, fades out
 * over `CONTEXT_INDICATOR_FADE_MS` (≤300 ms), then unmounts. It is NOT a
 * persistent HUD, and it renders `null` when idle, at a base-passthrough (an
 * Escape at the base is a no-op on the stack, so no change fires), and for a
 * refused / missing descent target.
 *
 * Three non-colour channels convey the change (R-4.1 "perceivable without
 * relying on colour alone"):
 *   1. the context TITLE (`hotkeys-context-indicator-label`, from
 *      `getHotkeyContext(contextId)?.title ?? contextId`);
 *   2. the direction ICON SHAPE (enter/`LuLayers` vs back/`LuChevronLeft`);
 *   3. the depth PIPS (`hotkeys-context-indicator-depth`, one pip per path level;
 *      base = 1).
 *
 * Accessibility: the visual root is `aria-hidden="true"` and
 * `pointerEvents: 'none'` — it is NEVER a second live region (the ONE shared
 * polite channel is `announce()`, `announcer.tsx`), so no `aria-live` /
 * `role="status"` is declared here.
 *
 * Colour is theme-token / CSS-var / the shared `tint()` helper only — zero
 * hex/rgba/hsl, zero `var(--x)NN` alpha-append.
 *
 * Reactivity: the snapshot is the module-cached FROZEN object from
 * `useActiveHotkeyContext()`, so the change effect depends on a stable identity
 * (never `.length` or a fresh object) — no re-render loop (#523 loop rule).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Icon, Text } from '@chakra-ui/react';
import { LuChevronLeft, LuLayers } from 'react-icons/lu';

import { tint } from '../utils/colorTint';
import { getHotkeyContext } from './contexts';
import { useActiveHotkeyContext } from './contextStack';

// ── Contract testids / attributes (plan BINDING block) ───────────────────────

export const HOTKEY_CONTEXT_INDICATOR_TESTID = 'hotkeys-context-indicator';
export const HOTKEY_CONTEXT_INDICATOR_LABEL_TESTID = 'hotkeys-context-indicator-label';
/** Display pips — NOT the body-hook depth attr (`data-fredo-hotkey-context-depth`). */
export const HOTKEY_CONTEXT_INDICATOR_DEPTH_TESTID = 'hotkeys-context-indicator-depth';
/** One pip element; `count === depth` (the non-colour level channel). */
export const HOTKEY_CONTEXT_INDICATOR_PIP_TESTID = 'hotkeys-context-indicator-pip';
/** The active context id, published on the indicator root. */
export const HOTKEY_CONTEXT_INDICATOR_ATTR = 'data-hotkey-context';

// ── Timing / stacking constants ──────────────────────────────────────────────

/** R-4.1 floor (≥1500 ms): how long the pill stays legible before hiding. */
export const CONTEXT_INDICATOR_DWELL_MS = 1800;
/** The exit fade (≤300 ms) — skipped entirely under `prefers-reduced-motion`. */
export const CONTEXT_INDICATOR_FADE_MS = 300;
/** Above the launcher overlay (1300), below the which-key overlay (1400). */
export const CONTEXT_INDICATOR_Z_INDEX = 1350;

const ENTER_ICON = LuLayers;
const BACK_ICON = LuChevronLeft;

/** The direction a change represents; `focus` re-enters a new base (enter shape). */
function directionFor(reason: string): 'enter' | 'back' {
  return reason === 'back' ? 'back' : 'enter';
}

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

export interface ContextIndicatorProps {
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/**
 * The transient context-change pill. Mounted ONCE by `HotkeysProvider`, beside
 * `HotkeyAnnouncer` / `WhichKeyOverlay`. Renders `null` when there is nothing to
 * show (idle / no real change).
 */
export function ContextIndicator({
  reducedMotion,
}: ContextIndicatorProps = {}): React.ReactElement | null {
  const snapshot = useActiveHotkeyContext();
  const queryReduced = usePrefersReducedMotion();
  const reduceMotion = reducedMotion ?? queryReduced;

  // Boot is NOT a user-triggered change: the mount-time snapshot is the baseline.
  const lastSeenRef = useRef(snapshot);
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);

  // Read the motion flag inside the change effect without adding it to the
  // dependency list (a mid-dwell media toggle must not strand the pill).
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Only a REAL change (new frozen snapshot identity) shows the pill.
    if (snapshot === lastSeenRef.current) return;
    lastSeenRef.current = snapshot;

    if (fadeTimerRef.current !== null) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    setVisible(true);
    setFading(false);

    if (!reduceMotionRef.current) {
      fadeTimerRef.current = setTimeout(() => {
        fadeTimerRef.current = null;
        setFading(true);
      }, Math.max(0, CONTEXT_INDICATOR_DWELL_MS - CONTEXT_INDICATOR_FADE_MS));
    }
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
      setFading(false);
    }, CONTEXT_INDICATOR_DWELL_MS);

    return () => {
      if (fadeTimerRef.current !== null) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [snapshot]);

  if (!visible) return null;

  const label = getHotkeyContext(snapshot.contextId)?.title ?? snapshot.contextId;
  const direction = directionFor(snapshot.reason);
  const pipCount = Math.max(1, snapshot.depth);

  return (
    <Box
      data-testid={HOTKEY_CONTEXT_INDICATOR_TESTID}
      data-hotkey-context={snapshot.contextId}
      data-direction={direction}
      data-reason={snapshot.reason}
      aria-hidden="true"
      position="fixed"
      top="4"
      left="50%"
      zIndex={CONTEXT_INDICATOR_Z_INDEX}
      style={{
        pointerEvents: 'none',
        transform: 'translateX(-50%)',
        opacity: fading ? 0 : 1,
        transition: reduceMotion ? 'none' : `opacity ${CONTEXT_INDICATOR_FADE_MS}ms ease`,
      }}
      display="flex"
      alignItems="center"
      gap="3"
      paddingX="3"
      paddingY="2"
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="full"
      boxShadow="var(--shadow-dialog)"
    >
      <Icon
        as={direction === 'back' ? BACK_ICON : ENTER_ICON}
        boxSize="4"
        color="fg.muted"
        data-testid={`${HOTKEY_CONTEXT_INDICATOR_TESTID}-icon`}
      />
      <Text
        data-testid={HOTKEY_CONTEXT_INDICATOR_LABEL_TESTID}
        fontSize="sm"
        color="fg.default"
        whiteSpace="nowrap"
      >
        {label}
      </Text>
      <Box
        data-testid={HOTKEY_CONTEXT_INDICATOR_DEPTH_TESTID}
        data-depth={snapshot.depth}
        display="flex"
        alignItems="center"
        gap="1"
      >
        {Array.from({ length: pipCount }, (_unused, index) => (
          <Box
            key={index}
            as="span"
            data-testid={HOTKEY_CONTEXT_INDICATOR_PIP_TESTID}
            boxSize="1.5"
            borderRadius="full"
            display="inline-block"
            bg={
              index === pipCount - 1
                ? tint('var(--accent-primary)', 80)
                : tint('var(--accent-primary)', 35)
            }
          />
        ))}
      </Box>
    </Box>
  );
}
