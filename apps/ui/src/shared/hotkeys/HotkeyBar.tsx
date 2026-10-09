/**
 * Spec #3009 CU-1 (ST-2) — the always-on bottom hotkey bar (plan UI/UX section,
 * EARS R-2.1…R-2.6, R-3.2).
 *
 * A persistent, full-bleed strip pinned to the bottom edge that lists EVERY
 * mounted `data-hotkey` element key in document order (never a pinned global),
 * renders every row disabled while focus is in a text-entry control or a
 * terminal session, and shows the pending two-step prefix. It renders `null`
 * when the model is empty (zero mounted element hotkeys — G-265 reach-back).
 *
 * DORMANT THIS UNIT: CU-1 only ADDS the component; CU-2 (ST-3) mounts it in
 * `HotkeysProvider`. It takes a pre-built `HotkeyBarModel` from the caller so
 * the pure model stays the single source of the rows/disabled/pending state.
 *
 * NON-INTRUSIVE (R-2.6): the root is `pointerEvents: 'none'`, has NO focusable
 * descendant, is NOT `aria-hidden` (it is perceivable) and is NOT `aria-live`
 * (the ONE shared `hotkeys-announcer` region remains the only live channel).
 *
 * Colour is theme-token / CSS-var / the shared `tint()` helper only — zero
 * hex/rgba/hsl, zero `var(--x)NN` alpha-append (AGENTS.md #2770). Motion is
 * opacity/transform only, `HOTKEY_BAR_FADE_MS`, disabled under
 * `prefers-reduced-motion`.
 */

import React, { useEffect, useState } from 'react';
import { Box, Icon, Text } from '@chakra-ui/react';
import { LuChevronRight, LuCircleSlash } from 'react-icons/lu';

import { Keycap } from '../components/hotkeys/Keycap';
import { tint } from '../utils/colorTint';
import { displaySequence, parseSequence } from './keys';
import { setElementHotkeysDisabled } from './hotkeyElements';
import type { HotkeyBarModel, HotkeyBarRow } from './hotkeyBarModel';
import type { Platform } from './types';

// ── Design constants (owned by ST-2; plan UI/UX §1) ──────────────────────────

/** Above desktop/window + launcher-rest (1200); below launcher-open (1300). */
export const HOTKEY_BAR_Z_INDEX = 1250;
/** Single-row strip height. */
export const HOTKEY_BAR_HEIGHT_PX = 34;
/** #2954 removed the persistent dock; the bar pins flush to `bottom:0`. */
export const HOTKEY_BAR_BOTTOM_INSET_PX = 0;
/** The row-list flex gap (Chakra `gap="2"` = 8 px). */
export const HOTKEY_BAR_ROW_GAP = 2;
/** One row clamp; the disabled row adds only a 14 px icon. */
export const HOTKEY_BAR_ROW_MAX_WIDTH_PX = 240;
/** The ellipsizing title can never collapse to 0 (G-274 floor). */
export const HOTKEY_BAR_TITLE_MIN_WIDTH_PX = 48;
/** Fade duration; opacity/transform only, none under reduced motion. */
export const HOTKEY_BAR_FADE_MS = 150;

// ── Contract testids + copy (plan BINDING NAMES BLOCK) ───────────────────────

export const HOTKEY_BAR_TESTID = 'hotkeys-keybar';
export const HOTKEY_BAR_LIST_TESTID = 'hotkeys-keybar-list';
export const HOTKEY_BAR_ROW_TESTID = 'hotkeys-keybar-row';
export const HOTKEY_BAR_PENDING_TESTID = 'hotkeys-keybar-pending';
export const HOTKEY_BAR_ARIA_LABEL = 'Available hotkeys';
export const HOTKEY_BAR_PENDING_LABEL = 'waiting…';

// ── Motion + scrollbar styles ────────────────────────────────────────────────

const FADE_KEYFRAMES = {
  '@keyframes hotkeys-keybar-fade': {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
} as const;

const MOTION_STYLE: React.CSSProperties = {
  animation: `hotkeys-keybar-fade ${HOTKEY_BAR_FADE_MS}ms ease`,
  transition: `opacity ${HOTKEY_BAR_FADE_MS}ms ease, transform ${HOTKEY_BAR_FADE_MS}ms ease`,
};
const NO_MOTION_STYLE: React.CSSProperties = { animation: 'none', transition: 'none' };

/** Themed thin scrollbar for the single horizontal scroll region (plan §2e). */
const LIST_SCROLLBAR_CSS = {
  '&::-webkit-scrollbar': { height: '6px' },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--scrollbar-thumb)',
    borderRadius: '3px',
  },
  '&::-webkit-scrollbar-thumb:hover': { background: 'var(--scrollbar-thumb-hover)' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve `prefers-reduced-motion` without adding a dependency. */
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

// ── One row ──────────────────────────────────────────────────────────────────

function HotkeyBarRowView({
  row,
  platform,
}: {
  readonly row: HotkeyBarRow;
  readonly platform?: Platform;
}): React.ReactElement {
  const disabled = row.availability === 'disabled';
  const ariaLabel = `${displaySequence(parseSequence(row.serialized), platform)}: ${row.title}`;
  return (
    <Box
      data-testid={HOTKEY_BAR_ROW_TESTID}
      role="listitem"
      data-hotkey-key={row.key}
      data-hotkey-action={row.actionId}
      data-hotkey-availability={row.availability}
      aria-label={ariaLabel}
      display="flex"
      alignItems="center"
      gap="1.5"
      paddingX="1.5"
      paddingY="0.5"
      borderRadius="sm"
      flexShrink={0}
      maxWidth={`${HOTKEY_BAR_ROW_MAX_WIDTH_PX}px`}
      minWidth="0"
      overflow="hidden"
      bg={disabled ? 'bg.muted' : undefined}
    >
      {disabled ? (
        <Icon as={LuCircleSlash} boxSize="3.5" color="fg.subtle" aria-hidden="true" flexShrink={0} />
      ) : null}
      {/* EXEMPT child 1 — the Keycap group never shrinks / ellipsizes (G-274). */}
      <Box aria-hidden="true" flexShrink={0}>
        <Keycap sequence={row.serialized} platform={platform} />
      </Box>
      {/* The ONE ellipsizing child — the row title (G-274). */}
      <Text
        fontSize="xs"
        color={disabled ? 'fg.muted' : 'fg.default'}
        whiteSpace="nowrap"
        flex="1"
        minWidth={`${HOTKEY_BAR_TITLE_MIN_WIDTH_PX}px`}
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {row.title}
      </Text>
    </Box>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────

export interface HotkeyBarProps {
  /** The pre-built model (`buildHotkeyBarModel`). `empty` renders `null`. */
  readonly model: HotkeyBarModel;
  /** Layout override so keycap display is deterministic in tests. */
  readonly platform?: Platform;
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/**
 * The always-on bottom hotkey bar. Renders `null` when `model.empty`; otherwise
 * a named, non-focusable `role="region"` strip.
 */
export function HotkeyBar({
  model,
  platform,
  reducedMotion,
}: HotkeyBarProps): React.ReactElement | null {
  const queryReduced = usePrefersReducedMotion();
  const reduceMotion = reducedMotion ?? queryReduced;

  // Publish the ST-1-owned disabled hook (G-266) while the bar is visible.
  const publishDisabled = model.disabled && !model.empty;
  useEffect(() => {
    setElementHotkeysDisabled(publishDisabled);
    return () => setElementHotkeysDisabled(false);
  }, [publishDisabled]);

  if (model.empty) return null;

  return (
    <Box
      data-testid={HOTKEY_BAR_TESTID}
      role="region"
      aria-label={HOTKEY_BAR_ARIA_LABEL}
      css={FADE_KEYFRAMES}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: `${HOTKEY_BAR_BOTTOM_INSET_PX}px`,
        pointerEvents: 'none',
        ...(reduceMotion ? NO_MOTION_STYLE : MOTION_STYLE),
      }}
      zIndex={HOTKEY_BAR_Z_INDEX}
      display="flex"
      alignItems="center"
      gap="3"
      height={`${HOTKEY_BAR_HEIGHT_PX}px`}
      paddingX="3"
      bg="bg.surface"
      borderTopWidth="1px"
      borderColor="border.default"
      boxShadow="var(--shadow-dialog)"
      overflow="hidden"
    >
      {/* The single horizontal scroll region — rows in document order. */}
      <Box position="relative" display="flex" alignItems="center" flex="1" minWidth="0">
        <Box
          data-testid={HOTKEY_BAR_LIST_TESTID}
          role="list"
          display="flex"
          alignItems="center"
          gap={HOTKEY_BAR_ROW_GAP}
          flex="1"
          minWidth="0"
          overflowX="auto"
          overflowY="hidden"
          css={LIST_SCROLLBAR_CSS}
        >
          {model.rows.map((row) => (
            <HotkeyBarRowView key={row.actionId} row={row} platform={platform} />
          ))}
        </Box>
        {/* Trailing edge fade: a non-interactive affordance over the clip edge. */}
        <Box
          aria-hidden="true"
          position="absolute"
          right="0"
          top="0"
          bottom="0"
          width="24px"
          pointerEvents="none"
          bg="linear-gradient(to right, transparent, var(--card-bg))"
        />
      </Box>

      {/* The pending-prefix chip — pinned OUTSIDE the scroll region. */}
      {model.pendingPrefix !== null ? (
        <Box
          data-testid={HOTKEY_BAR_PENDING_TESTID}
          flexShrink={0}
          display="flex"
          alignItems="center"
          gap="1.5"
          paddingX="2"
          paddingY="0.5"
          borderRadius="sm"
          bg={tint('var(--accent-primary)', 14)}
          borderWidth="1px"
          borderColor="accent.border"
        >
          <Keycap sequence={model.pendingPrefix} platform={platform} />
          <Icon as={LuChevronRight} boxSize="3.5" color="accent.default" aria-hidden="true" />
          <Text fontSize="xs" color="fg.default" whiteSpace="nowrap">
            {HOTKEY_BAR_PENDING_LABEL}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
