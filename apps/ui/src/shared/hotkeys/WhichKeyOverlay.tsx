/**
 * Spec #2946 ST-5 — the which-key pending-sequence overlay (plan UI/UX §1; EARS R-3.2).
 *
 * PO#10's first discoverability surface: while a multi-key sequence is pending it
 * names the pending prefix and the currently valid next keys. The overlay is
 * purely informational — `pointerEvents: 'none'` so it never steals a click — and
 * it renders ONLY while a NON-empty pending sequence exists. A single-chord action
 * (and a completed sequence, whose store projection is an empty prefix) shows
 * nothing.
 *
 * States (UI/UX §1 table):
 *   - idle     → not rendered
 *   - pending  → prefix `Keycap` chips + a wrapped grid of valid-next-key rows
 *   - invalid  → dead-end key: no action; icon + text reset, briefly nudged
 *   - timeout  → no stroke within `sequenceTimeoutMs`: same reset treatment
 *
 * The reset indication is icon + explicit text + motion (≤150 ms nudge), NEVER
 * colour-only, and the nudge is disabled under `prefers-reduced-motion`.
 *
 * Accessibility: the visual root is `aria-hidden="true"` — screen-reader exposure
 * is the ONE ST-3 announcer (`announce()`); this component declares no live region
 * of its own (no per-item `aria-live`).
 *
 * Latency: the matcher runs synchronously in the engine; this component only
 * consumes the store's transient snapshot (`getPendingSequence()` + the frozen
 * candidate list) — no IPC, no async gate, so the overlay appears on the very next
 * commit (<100 ms). It never depends on `.length` or a fresh object in an
 * effect/memo dependency (#523 loop rule); the store's frozen-singleton idle
 * candidates make the subscription stable.
 *
 * Position: anchored bottom-center, with the bottom inset DERIVED from the ACTUAL
 * rendered dock stack via `getBoundingClientRect()` (G-253 — never a nominal sum).
 * A non-rendered, hidden, or side-rail dock yields the documented base inset.
 *
 * Colour is theme-token / CSS-var / `tint()` only — zero hex/rgba, zero
 * `var(--x)NN` alpha-append.
 */

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, chakra, Icon, Text } from '@chakra-ui/react';
import { LuCircleX, LuTriangleAlert } from 'react-icons/lu';

import { Keycap } from '../components/hotkeys/Keycap';
import { tint } from '../utils/colorTint';
import { announce } from './announcer';
import { displaySequence, parseSequence } from './keys';
import {
  getPendingSequence,
  subscribeHotkeyEvents,
  subscribeHotkeys,
  useHotkeyCandidates,
} from './store';
import type { HotkeyCandidate, HotkeyResetReason, Platform } from './types';

// ── Contract testids (plan contract block 7 / UI/UX §1) ───────────────────────

export const WHICHKEY_OVERLAY_TESTID = 'hotkeys-whichkey-overlay';
export const WHICHKEY_PREFIX_TESTID = 'hotkeys-whichkey-prefix';
export const WHICHKEY_NEXT_LIST_TESTID = 'hotkeys-whichkey-next-list';
export const WHICHKEY_NEXT_ITEM_TESTID = 'hotkeys-whichkey-next-item';
export const WHICHKEY_INVALID_TESTID = 'hotkeys-whichkey-invalid';
export const WHICHKEY_TIMEOUT_TESTID = 'hotkeys-whichkey-timeout';

// ── Timing + geometry constants (module-level, named) ────────────────────────

/** The reset indication lingers this long before fading (UI/UX §1). */
export const WHICHKEY_RESET_FLASH_MS = 600;
/** The reset nudge duration — ≤150 ms, disabled under `prefers-reduced-motion`. */
export const WHICHKEY_NUDGE_MS = 150;
/** The announcer digest is bounded to this many candidates (first N + "and M more"). */
export const WHICHKEY_MAX_ANNOUNCED_CANDIDATES = 8;
/** Above the dock (z=1200) and the launcher overlay (z=1300). */
export const WHICHKEY_Z_INDEX = 1400;
/** Gap between the measured dock top and the overlay's bottom edge (px). */
export const WHICHKEY_BOTTOM_GAP_PX = 16;
/** Base bottom inset when no bottom-anchored dock is rendered (px). */
export const WHICHKEY_MIN_BOTTOM_PX = 24;
/** The dock root the offset is measured from; absent when zero windows. */
export const WHICHKEY_DOCK_SELECTOR = '[data-testid="app-dock"]';
/** Tolerance for "is the dock anchored at the bottom edge" (px). The bottom pill
 *  rests `12px` above the viewport edge, so the window is generous enough to
 *  admit a bottom inset while still excluding a mid-viewport side rail. */
const WHICHKEY_DOCK_BOTTOM_TOLERANCE_PX = 64;

const NUDGE_KEYFRAMES = {
  '@keyframes hotkeys-whichkey-nudge': {
    '0%': { transform: 'translateX(0)' },
    '35%': { transform: 'translateX(-6px)' },
    '70%': { transform: 'translateX(6px)' },
    '100%': { transform: 'translateX(0)' },
  },
} as const;

const INTENTIONAL_NUDGE: React.CSSProperties = {
  animation: `hotkeys-whichkey-nudge ${WHICHKEY_NUDGE_MS}ms ease-in-out`,
};
const NO_NUDGE: React.CSSProperties = { animation: 'none' };

type ResetReason = Extract<HotkeyResetReason, 'invalid' | 'timeout'>;

/**
 * The bottom inset for the overlay, DERIVED from the ACTUAL rendered dock stack
 * (G-253). Measures the dock's live `getBoundingClientRect().top` (so its real
 * height including border/padding is used, never a sum of nominal constants) when
 * — and only when — a dock is rendered, visible, and anchored to the bottom edge.
 * A side-rail dock, a hidden (edge-peek) dock, or no dock at all yields the base
 * inset. Exported so the derivation can be pinned directly.
 */
export function measureBottomOffsetPx(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return WHICHKEY_MIN_BOTTOM_PX;
  }
  const dock = document.querySelector<HTMLElement>(WHICHKEY_DOCK_SELECTOR);
  if (!dock) return WHICHKEY_MIN_BOTTOM_PX;

  const style = window.getComputedStyle(dock);
  if (style.visibility === 'hidden' || style.display === 'none') return WHICHKEY_MIN_BOTTOM_PX;

  const viewportH = window.innerHeight;
  const rect = dock.getBoundingClientRect();
  // Only a dock anchored at the bottom edge clears the overlay; a left rail does not.
  if (rect.bottom < viewportH - WHICHKEY_DOCK_BOTTOM_TOLERANCE_PX) return WHICHKEY_MIN_BOTTOM_PX;

  return Math.max(WHICHKEY_MIN_BOTTOM_PX, viewportH - rect.top + WHICHKEY_BOTTOM_GAP_PX);
}

/** The announcer digest for a pending prefix (UI/UX §1: first N + "and M more"). */
export function pendingAnnouncement(
  prefix: string,
  candidates: readonly HotkeyCandidate[],
  platform?: Platform,
): string {
  const prefixDisplay = displaySequence(parseSequence(prefix), platform);
  const shown = candidates.slice(0, WHICHKEY_MAX_ANNOUNCED_CANDIDATES);
  const parts = shown.map((candidate) => `${candidate.display} (${candidate.title})`);
  const remaining = candidates.length - shown.length;
  const suffix = remaining > 0 ? `, and ${remaining} more` : '';
  return `Prefix: ${prefixDisplay}. Valid next keys: ${parts.join(', ')}${suffix}.`;
}

/** The announcer copy for a reset state (UI/UX §1). */
export function resetAnnouncement(reason: ResetReason, prefix: string, platform?: Platform): string {
  if (reason === 'timeout') return 'Sequence timed out';
  const prefixDisplay = prefix.length > 0 ? displaySequence(parseSequence(prefix), platform) : '';
  return prefixDisplay.length > 0
    ? `No binding for ${prefixDisplay} — sequence cancelled`
    : 'Sequence cancelled';
}

function tierLabel(candidate: HotkeyCandidate): string {
  return candidate.tier === 'fredo' ? 'Global' : 'Feature';
}

export interface WhichKeyOverlayProps {
  /** Layout override so keycap display is deterministic in tests. */
  readonly platform?: Platform;
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/**
 * Renders the pending-sequence overlay. Mounted ONCE by `HotkeysProvider`
 * (ST-4), beside the shared announcer.
 */
export function WhichKeyOverlay({ platform, reducedMotion }: WhichKeyOverlayProps) {
  const pendingPrefix = useSyncExternalStore(
    subscribeHotkeys,
    getPendingSequence,
    getPendingSequence,
  );
  const candidates = useHotkeyCandidates();

  // `prefers-reduced-motion` — resolved through the OS media query by default.
  const queryState = usePrefersReducedMotion();
  const reduceMotion = reducedMotion ?? queryState;

  const [reset, setReset] = useState<{ reason: ResetReason; prefix: string } | null>(null);
  const [bottomPx, setBottomPx] = useState(WHICHKEY_MIN_BOTTOM_PX);

  /** The last non-empty pending prefix, for the reset copy (the store clears it). */
  const lastPrefixRef = useRef('');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The pending view requires BOTH a non-empty prefix and non-empty candidates;
  // an empty prefix/candidates (completion) is HIDDEN (ST-4 flag adjudication).
  const pendingActive = pendingPrefix !== null && pendingPrefix.length > 0 && candidates.length > 0;
  const visible = pendingActive || reset !== null;

  useEffect(() => {
    const clearResetTimer = (): void => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };

    const unsubscribe = subscribeHotkeyEvents((event) => {
      if (event.type === 'sequence:pending') {
        if (event.prefix.length > 0) {
          lastPrefixRef.current = event.prefix;
          clearResetTimer();
          setReset(null);
          if (event.candidates.length > 0) {
            announce(pendingAnnouncement(event.prefix, event.candidates, platform));
          }
        }
        return;
      }
      if (event.type === 'sequence:reset') {
        if (event.reason !== 'invalid' && event.reason !== 'timeout') return;
        const prefix = lastPrefixRef.current;
        clearResetTimer();
        setReset({ reason: event.reason, prefix });
        announce(resetAnnouncement(event.reason, prefix, platform));
        resetTimerRef.current = setTimeout(() => {
          resetTimerRef.current = null;
          setReset(null);
        }, WHICHKEY_RESET_FLASH_MS);
      }
    });

    return () => {
      unsubscribe();
      clearResetTimer();
    };
  }, [platform]);

  // Measure the ACTUAL rendered dock stack on every show (and keep it fresh while
  // the overlay is visible). No lazy/async gate — the visual commits immediately.
  useLayoutEffect(() => {
    if (!visible) return;
    const next = measureBottomOffsetPx();
    setBottomPx((previous) => (previous === next ? previous : next));
  }, [visible, pendingPrefix, reset]);

  useEffect(() => {
    if (!visible) return;
    const onResize = (): void => setBottomPx(measureBottomOffsetPx());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [visible]);

  if (!visible) return null;

  const nudgeStyle = reduceMotion ? NO_NUDGE : INTENTIONAL_NUDGE;

  return (
    <Box
      data-testid={WHICHKEY_OVERLAY_TESTID}
      aria-hidden="true"
      position="fixed"
      left="50%"
      zIndex={WHICHKEY_Z_INDEX}
      style={{
        pointerEvents: 'none',
        transform: 'translateX(-50%)',
        bottom: `${bottomPx}px`,
        width: 'max-content',
        maxWidth: 'min(560px, 90vw)',
      }}
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="md"
      boxShadow="var(--shadow-dialog)"
      padding="3"
    >
      {pendingActive ? (
        <>
          <Box
            data-testid={WHICHKEY_PREFIX_TESTID}
            display="flex"
            alignItems="center"
            gap="2"
            marginBottom="2"
          >
            <Keycap sequence={pendingPrefix ?? ''} platform={platform} />
          </Box>
          <Box
            data-testid={WHICHKEY_NEXT_LIST_TESTID}
            display="flex"
            flexWrap="wrap"
            gap="2"
          >
            {candidates.map((candidate) => (
              <Box
                key={candidate.strokeToken}
                data-testid={WHICHKEY_NEXT_ITEM_TESTID}
                display="flex"
                alignItems="center"
                gap="2"
                paddingX="1.5"
                paddingY="1"
                borderRadius="sm"
              >
                <Keycap sequence={candidate.strokeToken} platform={platform} />
                <Text fontSize="sm" color="fg.default" whiteSpace="nowrap">
                  {candidate.title}
                </Text>
                <chakra.span
                  fontSize="xs"
                  color="fg.muted"
                  bg="bg.subtle"
                  borderRadius="sm"
                  paddingX="1.5"
                  paddingY="0.5"
                  whiteSpace="nowrap"
                >
                  {tierLabel(candidate)}
                </chakra.span>
              </Box>
            ))}
          </Box>
        </>
      ) : reset ? (
        <Box
          data-testid={
            reset.reason === 'invalid' ? WHICHKEY_INVALID_TESTID : WHICHKEY_TIMEOUT_TESTID
          }
          css={NUDGE_KEYFRAMES}
          style={nudgeStyle}
          display="flex"
          alignItems="center"
          gap="2"
          borderRadius="sm"
          paddingX="2"
          paddingY="1"
          bg={tint('var(--status-error)', 10)}
          color="status.error"
        >
          <Icon as={reset.reason === 'invalid' ? LuCircleX : LuTriangleAlert} boxSize="4" />
          <Text fontSize="sm" color="fg.default">
            {reset.reason === 'invalid'
              ? `No binding for ${
                  reset.prefix.length > 0
                    ? displaySequence(parseSequence(reset.prefix), platform)
                    : 'those keys'
                } — sequence cancelled`
              : 'Sequence timed out'}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
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
