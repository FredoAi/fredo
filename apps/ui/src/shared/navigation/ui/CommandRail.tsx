/**
 * Spec #3118 (P4), ST-2 — `CommandRail`, the short view of the declaration.
 *
 * Answers one question: "where am I and what can I do next?" — the place breadcrumb, the
 * current place, the bound verbs (≤ 8, declaration order) with a key hint and a risk cue,
 * a `more…` affordance when the place overflows, and the two globals `? Map` / `/ Ask`.
 *
 * Source of truth (R-1.7): the rail renders ONE `CommandRailModel` produced by the ST-1
 * projection layer. It takes NO key table, NO `VerbDescriptor[]` and NO `Surface`, and it
 * re-derives NO binding — `model.rows` is rendered as-is (never sliced, padded or sorted).
 *
 * Structural invariants (binding, Architect §6 / QA Q1-07/Q1-08):
 *   - root `role="region"`, `aria-label={NAV_RAIL_ARIA_LABEL}`, `data-nav-surface="rail"`,
 *     `overflow: hidden`, `minWidth: NAV_RAIL_MIN_WIDTH_PX`, no `position`/`zIndex`;
 *   - NO `aria-live` region of its own, NO positive tabindex, NO focus move on mount;
 *   - a place transition re-homes focus the rail itself dropped (the same control when it
 *     reappears, else the current-place heading — the programmatic `tabIndex={-1}` anchor)
 *     and NEVER steals focus the user moved elsewhere (#3119 R-9 / AC9, §11.5);
 *   - no horizontal scroll anywhere: the rail is a column, every row is `minWidth: 0` and
 *     only the title ellipsizes (G-274).
 *
 * Unavailable rows and the disabled `/ Ask` stay in the DOM and in keyboard/SR reach:
 * `aria-disabled` + a token-muted style + the reason in the accessible name/tooltip — never a
 * native `disabled` that would remove them from the tab order (R-1.3 / R-1.4).
 *
 * Motion is opacity/transform only, `NAV_MOTION_MS`-based and gated by `reducedMotion` (the
 * prop or `useNavReducedMotion()`); colour is theme tokens + `tint()` only (R-5.1 / R-5.2).
 * Re-render contract: derived off `model` only — no `.length`/fresh-array effect deps (#523).
 */

import React from 'react';
import { Box, chakra, Icon, Separator, Text, VisuallyHidden } from '@chakra-ui/react';
import { LuCircleSlash, LuExternalLink, LuTriangleAlert } from 'react-icons/lu';
import type { IconType } from 'react-icons';

import type { Platform } from '../../hotkeys/types';
import {
  NAV_RAIL_ARIA_LABEL,
  NAV_RAIL_ASK_TESTID,
  NAV_RAIL_BREADCRUMB_MAX_WIDTH_PX,
  NAV_RAIL_BREADCRUMB_TESTID,
  NAV_RAIL_EMPTY_COPY,
  NAV_RAIL_LIST_TESTID,
  NAV_RAIL_MAP_TESTID,
  NAV_RAIL_MIN_WIDTH_PX,
  NAV_RAIL_MORE_TESTID,
  NAV_MORE_ARIA_LABEL,
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_PLACES_LABEL,
  NAV_RAIL_PLACES_TESTID,
  NAV_RAIL_PLACE_TESTID,
  NAV_RAIL_RISK_TESTID,
  NAV_RAIL_ROW_MAX_WIDTH_PX,
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
  /** The `/ Ask` affordance — inert in P4. */
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
    <chakra.li role="listitem" display="block" minWidth="0">
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
        minWidth="0"
        alignItems="center"
        gap="1.5"
        width="100%"
        maxWidth={`${NAV_RAIL_ROW_MAX_WIDTH_PX}px`}
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

// ── The rail ────────────────────────────────────────────────────────────────

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

  return (
    <Box
      ref={railRef}
      onFocus={handleRailFocus}
      data-testid={NAV_RAIL_TESTID}
      data-nav-surface="rail"
      role="region"
      aria-label={NAV_RAIL_ARIA_LABEL}
      display="block"
      width="100%"
      maxWidth="266px"
      p="3"
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="md"
      // The no-horizontal-scroll contract: a narrow floor, a clipped box, a column layout.
      style={{ minWidth: `${NAV_RAIL_MIN_WIDTH_PX}px`, overflow: 'hidden' }}
    >
      <chakra.ol
        data-testid={NAV_RAIL_BREADCRUMB_TESTID}
        role="list"
        display="flex"
        minWidth="0"
        flexWrap="wrap"
        alignItems="center"
        rowGap="1"
        maxWidth={`${NAV_RAIL_BREADCRUMB_MAX_WIDTH_PX}px`}
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
              minWidth="0"
              flex={last ? '1 1 auto' : undefined}
              flexShrink={last ? undefined : 0}
              alignItems="center"
              whiteSpace="nowrap"
              overflow={last ? 'hidden' : undefined}
            >
              {index > 0 ? (
                <chakra.span aria-hidden="true" color="fg.subtle" px="1">
                  ›
                </chakra.span>
              ) : null}
              <chakra.span
                color={last ? 'fg.default' : 'fg.muted'}
                fontSize="xs"
                minWidth={last ? '0' : undefined}
                overflow={last ? 'hidden' : undefined}
                textOverflow={last ? 'ellipsis' : undefined}
                whiteSpace="nowrap"
              >
                {place.label}
              </chakra.span>
            </chakra.li>
          );
        })}
      </chakra.ol>

      <chakra.h2
        data-testid={NAV_RAIL_PLACE_TESTID}
        title={model.currentPlace.label}
        // The place-transition focus anchor: programmatically focusable, never in the tab
        // order (the no-focus-steal contract holds).
        tabIndex={-1}
        mt="1"
        mb="0"
        fontSize="sm"
        fontWeight="semibold"
        color="fg.default"
        lineClamp={2}
        overflow="hidden"
      >
        {model.currentPlace.label}
      </chakra.h2>

      {model.transientMarker === null ? null : (
        <Box
          data-testid={NAV_RAIL_TRANSIENT_TESTID}
          alignSelf="flex-start"
          mt="1"
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

      <Separator my="2" borderColor="border.subtle" />

      {model.placeRows.length === 0 ? null : (
        <Box display="block" minWidth="0" mb="2">
          <Text
            px="2"
            mb="1"
            fontSize="2xs"
            fontWeight="medium"
            color="fg.subtle"
            textTransform="uppercase"
            letterSpacing="wider"
          >
            {NAV_RAIL_PLACES_LABEL}
          </Text>
          <Box
            data-testid={NAV_RAIL_PLACES_TESTID}
            role="list"
            as="ul"
            display="flex"
            minWidth="0"
            flexDirection="column"
            gap="0.5"
            width="100%"
            listStyleType="none"
            p="0"
            m="0"
          >
            {model.placeRows.map((placeRow) => (
              <chakra.li key={placeRow.placeId} role="listitem" display="block" minWidth="0">
                <chakra.button
                  type="button"
                  data-testid={NAV_RAIL_PLACE_ROW_TESTID}
                  data-nav-place-id={placeRow.placeId}
                  title={placeRow.tooltip}
                  aria-label={placeRow.tooltip}
                  onClick={() => onRunVerb(placeRow.placeId)}
                  display="flex"
                  minWidth="0"
                  alignItems="center"
                  gap="1.5"
                  width="100%"
                  maxWidth={`${NAV_RAIL_ROW_MAX_WIDTH_PX}px`}
                  height="24px"
                  px="2"
                  borderRadius="sm"
                  borderWidth="0"
                  bg="transparent"
                  color="fg.default"
                  textAlign="left"
                  cursor="pointer"
                  overflow="hidden"
                  _hover={{ bg: 'bg.hover' }}
                  _active={motionReduced ? undefined : { transform: 'scale(0.99)' }}
                  _focusVisible={FOCUS_VISIBLE}
                >
                  <NavKeycap keys={placeRow.keys} platform={platform} />
                  <Text
                    flex="1 1 auto"
                    minWidth={`${NAV_RAIL_TITLE_MIN_WIDTH_PX}px`}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    fontSize="xs"
                    color="fg.default"
                  >
                    {placeRow.label}
                  </Text>
                </chakra.button>
              </chakra.li>
            ))}
          </Box>
        </Box>
      )}

      <Box display="block" minWidth="0">
        <Box
          key={model.currentPlace.id}
          data-testid={NAV_RAIL_LIST_TESTID}
          role="list"
          as="ul"
          display="flex"
          minWidth="0"
          flexDirection="column"
          gap="0.5"
          width="100%"
          listStyleType="none"
          p="0"
          m="0"
          css={RAIL_IN_KEYFRAMES}
          style={motionReduced ? RAIL_NO_MOTION_STYLE : RAIL_MOTION_STYLE}
        >
          {model.rows.length === 0 ? (
            <chakra.li role="listitem" display="block" minWidth="0">
              <Text py="2" fontSize="sm" color="fg.muted">
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
        </Box>

        {more === null ? null : (
          <chakra.button
            type="button"
            data-testid={NAV_RAIL_MORE_TESTID}
            title={more.label}
            aria-label={NAV_MORE_ARIA_LABEL}
            onClick={() => onOpenMap(more.opensFilteredTo)}
            display="flex"
            minWidth="0"
            alignItems="center"
            height="28px"
            px="2"
            mt="0.5"
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
        )}
      </Box>

      <Separator mt="2" borderColor="border.subtle" />

      <Box display="flex" minWidth="0" justifyContent="flex-end" gap="1" mt="2">
        <chakra.button
          type="button"
          data-testid={NAV_RAIL_MAP_TESTID}
          title={model.map.tooltip}
          onClick={() => onOpenMap(null)}
          display="inline-flex"
          minWidth="0"
          alignItems="center"
          gap="1"
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
            // The `/ Ask` affordance is disabled in P4 — keep it focusable, dispatch nothing.
            if (model.ask.enabled) onAsk?.();
          }}
          display="inline-flex"
          minWidth="0"
          alignItems="center"
          gap="1"
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
