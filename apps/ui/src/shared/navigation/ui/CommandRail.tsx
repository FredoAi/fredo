/**
 * Spec #3118 (P4), ST-2 — `CommandRail`, reworked by Spec #3120 (P6 rescope, ST-5) into the
 * **bottom command bar**.
 *
 * Answers one question: "where am I and what can I do next?" — the place breadcrumb on the
 * left, the current place's bound verbs (≤ 8, declaration order) centred, `more…` inline at
 * the end of the cluster, and the two globals `? Map` / `Ask` on the right. There is NO
 * child-place list and NO duplicate current-place heading (UIUX-D4 / R-1.4).
 *
 * Source of truth (R-1.7): the bar renders ONE `CommandRailModel` produced by the ST-1
 * projection layer. It takes NO key table, NO `VerbDescriptor[]` and NO `Surface`, and it
 * re-derives NO binding — `model.rows` is rendered as-is (never sliced, padded or sorted).
 *
 * Structural invariants (binding, Architect §6 / QA F-N25 … F-N28):
 *   - root `role="region"`, `aria-label={NAV_RAIL_ARIA_LABEL}`, `data-nav-surface="bar"`,
 *     a horizontal flex row, `minHeight: NAV_BAR_MIN_HEIGHT_PX`, `overflowX: hidden`;
 *   - the last breadcrumb segment is the `NAV_RAIL_PLACE_TESTID` anchor
 *     (`tabIndex={-1}`, `aria-current="page"`) and the ONLY ellipsizing breadcrumb segment;
 *   - the verb cluster WRAPS and the bar GROWS VERTICALLY with width (UIUX-D6) — every row
 *     keeps a `NAV_BAR_ROW_MIN_WIDTH_PX` floor and the bar never scrolls horizontally;
 *   - NO `aria-live` region of its own, NO positive tabindex, NO focus move on mount;
 *   - a place transition re-homes focus the bar itself dropped (the same control when it
 *     reappears, else the current-place breadcrumb segment — the programmatic
 *     `tabIndex={-1}` anchor) and NEVER steals focus the user moved elsewhere (#3119 R-9).
 *
 * Unavailable rows stay in the DOM and in keyboard/SR reach: `aria-disabled` + a
 * token-muted style + the reason in the accessible name/tooltip — never a native `disabled`
 * that would remove them from the tab order (R-1.3 / R-1.4).
 *
 * Motion is opacity/transform only, `NAV_MOTION_MS`-based and gated by `reducedMotion` (the
 * prop or `useNavReducedMotion()`); colour is theme tokens + `tint()` only (R-5.1 / R-5.2).
 * Re-render contract: derived off `model` only — no `.length`/fresh-array effect deps (#523).
 */

import React from 'react';
import { Box, chakra, Icon, Text, VisuallyHidden } from '@chakra-ui/react';
import { LuCircleSlash, LuExternalLink, LuTriangleAlert } from 'react-icons/lu';
import type { IconType } from 'react-icons';

import type { Platform } from '../../hotkeys/types';
import {
  NAV_BAR_MIN_HEIGHT_PX,
  NAV_BAR_ROW_GAP_PX,
  NAV_BAR_ROW_MIN_WIDTH_PX,
  NAV_RAIL_ARIA_LABEL,
  NAV_RAIL_ASK_TESTID,
  NAV_RAIL_BREADCRUMB_TESTID,
  NAV_RAIL_EMPTY_COPY,
  NAV_RAIL_LIST_TESTID,
  NAV_RAIL_MAP_TESTID,
  NAV_RAIL_MORE_TESTID,
  NAV_MORE_ARIA_LABEL,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_RISK_TESTID,
  NAV_RAIL_ROW_TESTID,
  NAV_RAIL_TESTID,
  NAV_RAIL_TITLE_MIN_WIDTH_PX,
  NAV_RAIL_TRANSIENT_TESTID,
  NAV_MOTION_MS,
} from './constants';
import { NavKeycap } from './Keycap';
import type { CommandRailModel, CommandRailRow, NavRiskCue } from './types';
import { useNavReducedMotion } from './useReducedMotion';
import { usePlaceTransitionFocus } from './usePlaceTransitionFocus';

export interface CommandRailProps {
  /** The ONE view-model (built by `buildCommandRailModel`). No key table, no verb list. */
  readonly model: CommandRailModel;
  /** Layout override so keycap display is deterministic in tests. */
  readonly platform?: Platform;
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
  /** Run one bound verb (never called for an unavailable row). */
  readonly onRunVerb: (verbId: string) => void;
  /** Open the navigation map; `null` = the full tree, a place id = filtered to that place. */
  readonly onOpenMap: (filterPlaceId?: string | null) => void;
  /**
   * The `Ask` affordance. Spec #3120: the shell publishes a composer request through the
   * companion bridge (`requestCompanionComposerOpen`) so the instruction box opens focused
   * on Fredo's teleport — ST-6 owns the final shell wiring.
   */
  readonly onAsk?: () => void;
}

// ── Motion (opacity/transform only; disabled under reduced motion) ───────────

const RAIL_IN_KEYFRAMES = {
  '@keyframes navigation-rail-in': {
    from: { opacity: 0, transform: 'translateY(4px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
} as const;

const RAIL_MOTION_STYLE: React.CSSProperties = {
  animation: `navigation-rail-in ${NAV_MOTION_MS}ms ease`,
};
const RAIL_NO_MOTION_STYLE: React.CSSProperties = { animation: 'none', transition: 'none' };

/** The example row width ceiling (the row's title is the ONE ellipsizing child). */
const ROW_MAX_WIDTH_PX = 168;

/** The focus ring token pair (visible focus, never `outline: none`). */
const FOCUS_VISIBLE = {
  outline: '2px solid var(--accent-strong)',
  outlineOffset: '-2px',
} as const;

// ── Risk cue ────────────────────────────────────────────────────────────────

/** The decorative risk icon (the WORD carries the meaning — R-7.2 / Q7-02). */
function riskIcon(cue: NavRiskCue): IconType {
  return cue === 'external' ? LuExternalLink : LuTriangleAlert;
}

/** Status token for the decorative risk icon; `safe` never renders a cue. */
function riskColor(cue: NavRiskCue): string {
  if (cue === 'mutating') return 'status.warning';
  if (cue === 'destructive') return 'status.error';
  if (cue === 'external') return 'status.info';
  return 'fg.subtle';
}

// ── One verb row ────────────────────────────────────────────────────────────

function RailRow({
  row,
  platform,
  motionReduced,
  onRunVerb,
}: {
  readonly row: CommandRailRow;
  readonly platform?: Platform;
  readonly motionReduced: boolean;
  readonly onRunVerb: (verbId: string) => void;
}): React.ReactElement {
  const titleColor = row.enabled ? 'fg.default' : 'fg.subtle';
  return (
    <chakra.li role="listitem" display="flex" flexShrink={0} minWidth="0">
      <chakra.button
        type="button"
        data-testid={NAV_RAIL_ROW_TESTID}
        data-nav-verb-id={row.verbId}
        data-nav-availability={row.enabled ? 'available' : 'disabled'}
        data-nav-risk={row.risk}
        aria-label={row.tooltip}
        aria-disabled={row.enabled ? undefined : 'true'}
        title={row.tooltip}
        onClick={() => {
          // aria-disabled (never native `disabled`) keeps the row focusable; the action is
          // guarded here so a disabled row dispatches nothing (R-1.3).
          if (row.enabled) onRunVerb(row.verbId);
        }}
        display="flex"
        alignItems="center"
        gap="1.5"
        flexShrink={0}
        minWidth={`${NAV_BAR_ROW_MIN_WIDTH_PX}px`}
        maxWidth={`${ROW_MAX_WIDTH_PX}px`}
        height="28px"
        px="2"
        borderRadius="sm"
        borderWidth="0"
        bg="transparent"
        color={titleColor}
        textAlign="left"
        cursor={row.enabled ? 'pointer' : 'not-allowed'}
        overflow="hidden"
        _hover={row.enabled ? { bg: 'bg.hover' } : undefined}
        _active={!row.enabled || motionReduced ? undefined : { transform: 'scale(0.99)' }}
        _focusVisible={FOCUS_VISIBLE}
      >
        {row.enabled ? null : (
          <Icon as={LuCircleSlash} boxSize="3" color="fg.subtle" aria-hidden="true" flexShrink={0} />
        )}
        <NavKeycap keys={row.keys} platform={platform} />
        {/* The ONE ellipsizing child (G-274) — floor keeps it from collapsing to zero. */}
        <Text
          flex="1 1 auto"
          minWidth={`${NAV_RAIL_TITLE_MIN_WIDTH_PX}px`}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          fontSize="sm"
          color={titleColor}
        >
          {row.title}
        </Text>
        {row.riskLabel === null ? null : (
          <Box
            data-testid={NAV_RAIL_RISK_TESTID}
            display="inline-flex"
            alignItems="center"
            gap="1"
            flexShrink={0}
            color={titleColor}
          >
            <Icon
              as={riskIcon(row.riskCue)}
              boxSize="3"
              color={riskColor(row.riskCue)}
              aria-hidden="true"
            />
            <Text fontSize="2xs" fontWeight="medium" whiteSpace="nowrap">
              {row.riskLabel}
            </Text>
          </Box>
        )}
      </chakra.button>
    </chakra.li>
  );
}

// ── The bar ─────────────────────────────────────────────────────────────────

export function CommandRail({
  model,
  platform,
  reducedMotion,
  onRunVerb,
  onOpenMap,
  onAsk,
}: CommandRailProps): React.ReactElement {
  const queryReduced = useNavReducedMotion();
  const motionReduced = reducedMotion ?? queryReduced;
  const more = model.more;
  const askReasonId = React.useId();
  const { railRef, onFocus: handleRailFocus } = usePlaceTransitionFocus(model);
  const motionStyle = motionReduced ? RAIL_NO_MOTION_STYLE : RAIL_MOTION_STYLE;

  return (
    <Box
      ref={railRef}
      onFocus={handleRailFocus}
      data-testid={NAV_RAIL_TESTID}
      data-nav-surface="bar"
      role="region"
      aria-label={NAV_RAIL_ARIA_LABEL}
      display="flex"
      alignItems="center"
      width="100%"
      gap="2"
      px="3"
      py="1"
      bg="bg.surface"
      borderTopWidth="1px"
      borderColor="border.default"
      // The no-horizontal-scroll contract: the bar clips, the cluster wraps instead of
      // scrolling, and the bar grows vertically with its content (UIUX-D6).
      style={{ minHeight: `${NAV_BAR_MIN_HEIGHT_PX}px`, overflowX: 'hidden' }}
    >
      {/* ── Left: breadcrumb (last segment = current place + focus anchor) ── */}
      <chakra.ol
        data-testid={NAV_RAIL_BREADCRUMB_TESTID}
        role="list"
        display="flex"
        alignItems="center"
        flexShrink={0}
        minWidth="0"
        maxW="40%"
        listStyleType="none"
        p="0"
        m="0"
      >
        {model.breadcrumb.map((place, index) => {
          const last = index === model.breadcrumb.length - 1;
          return (
            <chakra.li
              key={place.id}
              data-nav-place-id={place.id}
              display="flex"
              alignItems="center"
              minWidth="0"
              flexShrink={last ? 1 : 0}
              whiteSpace="nowrap"
            >
              {index > 0 ? (
                <chakra.span aria-hidden="true" color="fg.subtle" px="1">
                  ›
                </chakra.span>
              ) : null}
              {last ? (
                // UIUX-D4: the last segment IS the current place — the programmatic
                // `tabIndex={-1}` focus anchor, never a tab stop, and the ONLY ellipsis.
                <chakra.span
                  data-testid={NAV_RAIL_PLACE_TESTID}
                  data-nav-current="true"
                  aria-current="page"
                  title={model.currentPlace.label}
                  tabIndex={-1}
                  display="inline-block"
                  minWidth="0"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                  fontSize="xs"
                  color="fg.default"
                  _focusVisible={FOCUS_VISIBLE}
                >
                  {place.label}
                </chakra.span>
              ) : (
                <chakra.span color="fg.muted" fontSize="xs" whiteSpace="nowrap">
                  {place.label}
                </chakra.span>
              )}
            </chakra.li>
          );
        })}
      </chakra.ol>

      {model.transientMarker === null ? null : (
        <Box
          data-testid={NAV_RAIL_TRANSIENT_TESTID}
          flexShrink={0}
          px="2"
          py="0.5"
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="accent.border"
          borderRadius="sm"
          fontSize="2xs"
          color="fg.default"
        >
          {model.transientMarker}
        </Box>
      )}

      {/* ── Centre: the wrapping verb cluster (`more…` inline at its end) ── */}
      <Box
        data-testid={NAV_RAIL_LIST_TESTID}
        role="list"
        as="ul"
        display="flex"
        flex="1 1 auto"
        minWidth="0"
        flexWrap="wrap"
        justifyContent="center"
        alignItems="center"
        listStyleType="none"
        p="0"
        m="0"
        css={RAIL_IN_KEYFRAMES}
        style={{
          ...motionStyle,
          columnGap: `${NAV_BAR_ROW_GAP_PX}px`,
          rowGap: `${NAV_BAR_ROW_GAP_PX}px`,
        }}
      >
        {model.rows.length === 0 ? (
          <chakra.li role="listitem" display="flex" minWidth="0">
            <Text py="1" px="2" fontSize="sm" color="fg.muted">
              {NAV_RAIL_EMPTY_COPY}
            </Text>
          </chakra.li>
        ) : (
          model.rows.map((row) => (
            <RailRow
              key={row.verbId}
              row={row}
              platform={platform}
              motionReduced={motionReduced}
              onRunVerb={onRunVerb}
            />
          ))
        )}

        {more === null ? null : (
          <chakra.li role="listitem" display="flex" flexShrink={0}>
            <chakra.button
              type="button"
              data-testid={NAV_RAIL_MORE_TESTID}
              title={more.label}
              aria-label={NAV_MORE_ARIA_LABEL}
              onClick={() => onOpenMap(more.opensFilteredTo)}
              display="flex"
              alignItems="center"
              flexShrink={0}
              minWidth={`${NAV_BAR_ROW_MIN_WIDTH_PX}px`}
              justifyContent="center"
              height="28px"
              px="2"
              borderRadius="sm"
              borderWidth="0"
              bg="transparent"
              color="fg.default"
              fontSize="xs"
              cursor="pointer"
              _hover={{ bg: 'bg.hover' }}
              _focusVisible={FOCUS_VISIBLE}
            >
              {more.label}
            </chakra.button>
          </chakra.li>
        )}
      </Box>

      {/* ── Right: the two globals ── */}
      <Box display="flex" alignItems="center" gap="1" flexShrink={0}>
        <chakra.button
          type="button"
          data-testid={NAV_RAIL_MAP_TESTID}
          title={model.map.tooltip}
          onClick={() => onOpenMap(null)}
          display="inline-flex"
          alignItems="center"
          gap="1"
          flexShrink={0}
          height="28px"
          px="2"
          borderRadius="sm"
          borderWidth="0"
          bg="transparent"
          color="fg.default"
          cursor="pointer"
          _hover={{ bg: 'bg.hover' }}
          _focusVisible={FOCUS_VISIBLE}
        >
          <NavKeycap keys={[]} glyph={model.map.glyph} />
          <Text fontSize="xs" color="fg.default" whiteSpace="nowrap">
            {model.map.label}
          </Text>
        </chakra.button>

        <chakra.button
          type="button"
          data-testid={NAV_RAIL_ASK_TESTID}
          title={model.ask.tooltip}
          aria-disabled={model.ask.enabled ? undefined : 'true'}
          aria-describedby={model.ask.reason === null ? undefined : askReasonId}
          onClick={() => {
            // A disabled affordance keeps no reason node in P6; the guard stays as a belt.
            if (model.ask.enabled) onAsk?.();
          }}
          display="inline-flex"
          alignItems="center"
          gap="1"
          flexShrink={0}
          height="28px"
          px="2"
          borderRadius="sm"
          borderWidth="0"
          bg="transparent"
          color={model.ask.enabled ? 'fg.default' : 'fg.subtle'}
          cursor={model.ask.enabled ? 'pointer' : 'not-allowed'}
          _hover={model.ask.enabled ? { bg: 'bg.hover' } : undefined}
          _focusVisible={FOCUS_VISIBLE}
        >
          <NavKeycap keys={[]} glyph={model.ask.glyph} />
          <Text fontSize="xs" whiteSpace="nowrap">
            {model.ask.label}
          </Text>
        </chakra.button>
      </Box>

      {model.ask.reason === null ? null : (
        <VisuallyHidden id={askReasonId}>{model.ask.reason}</VisuallyHidden>
      )}
    </Box>
  );
}
