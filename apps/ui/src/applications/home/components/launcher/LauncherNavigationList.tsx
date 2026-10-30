/**
 * Spec #3120 (P6), ST-5 — `LauncherNavigationList`, the grouped Place → Verb listbox.
 *
 * Presentational ONLY (mirrors `LauncherActionList` / `LauncherAppGrid`): it renders the
 * ONE `LauncherPaletteModel` (recents first, then one group per place in model order) and
 * reports a row selection UP to the host via `onSelect(index)`. It runs nothing, opens
 * nothing, owns no query and adds no keydown listener — the shell keeps DOM focus in the
 * searchbox and drives `aria-activedescendant` at these rows.
 *
 * Contract (UI/UX §2.2):
 *   - group heading = the FULL `pathLabel` (never truncated) — the row never has to be
 *     cross-referenced; no sticky heading (G-253);
 *   - a `recent` row carries the `Recent` micro-label (the model is place-keyed — no
 *     invented pseudo-group);
 *   - a risk chip renders ONLY for a non-safe risk, with an `aria-hidden` icon and the
 *     WORD (`row.riskLabel`) as the meaning — no status hue ever carries text;
 *   - an unavailable row is `aria-disabled="true"` (never native `disabled`), keeps the
 *     slash glyph + `NAV_UNAVAILABLE_REASON`, stays selectable and dispatches nothing;
 *   - an empty filtered model renders `LAUNCHER_PALETTE_EMPTY_COPY` inside the list root
 *     (plain text, never a second live region);
 *   - the ONE polite region lives in the shell (`launcher-palette-announcer`); this
 *     component announces nothing itself.
 *
 * Token-only styling: semantic tokens and `tint()` over vars — zero colour literals and
 * zero `var(--x)NN` alpha-appends. Reduced motion removes the entrance/selection motion.
 */

import React from 'react';
import { Box, Icon, Text } from '@chakra-ui/react';
import { LuCircleSlash, LuExternalLink, LuSearch, LuTriangleAlert } from 'react-icons/lu';

import { Keycap } from '../../../../shared/components/hotkeys/Keycap';
import { NavKeycap } from '../../../../shared/navigation/ui/Keycap';
import { useNavReducedMotion } from '../../../../shared/navigation/ui/useReducedMotion';
import { tint } from '../../../../shared/utils/colorTint';
import {
  LAUNCHER_PALETTE_ARIA_LABEL,
  LAUNCHER_PALETTE_EMPTY_COPY,
  LAUNCHER_PALETTE_GROUP_PATH_TESTID,
  LAUNCHER_PALETTE_GROUP_TESTID,
  LAUNCHER_PALETTE_LIST_TESTID,
  LAUNCHER_PALETTE_ROW_KEY_TESTID,
  LAUNCHER_PALETTE_ROW_RISK_TESTID,
  LAUNCHER_PALETTE_ROW_TESTID,
  LAUNCHER_RECENT_LABEL,
  LAUNCHER_SECONDARY_SEQUENCE,
  LAUNCHER_SECTION_ATTR,
  launcherNavigationRowId,
  launcherPaletteAnnouncement,
} from './launcherConstants';
import type { LauncherPaletteModel, LauncherPaletteRow } from './launcherNavigationPalette';

export interface LauncherNavigationListProps {
  /** The ONE view-model (built/filtered by the ST-5 pure modules). */
  readonly model: LauncherPaletteModel;
  /** Index into `model.rows` (the flattened selection order). */
  readonly selectedIndex: number;
  /** Select a row; the shell owns the selection index. */
  readonly onSelect: (index: number) => void;
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
  /** The shell passes its reply-band container ref so keep-out follows the list. */
  readonly containerRef?: React.Ref<HTMLDivElement>;
}

/** UI/UX §4 — the list/selection timing (opacity/background only). */
const PALETTE_MOTION_MS = 120;

const LIST_KEYFRAMES = {
  '@keyframes launcher-palette-in': {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
} as const;

const LIST_MOTION_STYLE: React.CSSProperties = {
  animation: `launcher-palette-in ${PALETTE_MOTION_MS}ms ease`,
};
const LIST_NO_MOTION_STYLE: React.CSSProperties = { animation: 'none', transition: 'none' };

const FOCUS_VISIBLE = {
  outline: '2px solid var(--accent-strong)',
  outlineOffset: '2px',
} as const;

const LIST_SCROLLBAR_CSS = {
  '&::-webkit-scrollbar': { width: '8px', height: '8px' },
  '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
} as const;

/** The decorative risk icon (the WORD carries the meaning). */
function riskIcon(risk: LauncherPaletteRow['risk']) {
  return risk === 'external' ? LuExternalLink : LuTriangleAlert;
}

/** Status token for the decorative risk icon; `safe` never renders a chip. */
function riskColor(risk: LauncherPaletteRow['risk']): string {
  if (risk === 'mutating') return 'status.warning';
  if (risk === 'destructive') return 'status.error';
  if (risk === 'external') return 'status.info';
  return 'fg.subtle';
}

/** The status var a risk chip tints against. */
function riskVar(risk: LauncherPaletteRow['risk']): string {
  if (risk === 'mutating') return 'var(--status-warning)';
  if (risk === 'destructive') return 'var(--status-error)';
  return 'var(--status-info)';
}

interface NavigationRowProps {
  readonly row: LauncherPaletteRow;
  readonly index: number;
  readonly selected: boolean;
  readonly motionReduced: boolean;
  readonly onSelect: (index: number) => void;
}

function NavigationRow({
  row,
  index,
  selected,
  motionReduced,
  onSelect,
}: NavigationRowProps): React.ReactElement {
  const announcement = row.available
    ? launcherPaletteAnnouncement(row)
    : `${launcherPaletteAnnouncement(row)} — ${row.reason ?? ''}`;
  const titleColor = row.available ? 'fg.default' : 'fg.subtle';

  return (
    <Box
      role="option"
      id={launcherNavigationRowId(index)}
      data-testid={LAUNCHER_PALETTE_ROW_TESTID}
      data-nav-verb-id={row.verbId}
      data-nav-risk={row.risk}
      data-nav-availability={row.available ? 'available' : 'disabled'}
      {...{ [LAUNCHER_SECTION_ATTR]: row.section }}
      aria-selected={selected}
      aria-disabled={row.available ? undefined : 'true'}
      aria-label={announcement}
      title={announcement}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(index)}
      display="flex"
      alignItems="center"
      gap={2}
      minHeight="34px"
      px={3}
      py={1.5}
      borderRadius="md"
      borderWidth="1px"
      borderColor={selected ? 'var(--accent-primary)' : 'transparent'}
      bg={selected ? tint('var(--accent-primary)', 22) : 'transparent'}
      cursor="pointer"
      transition={
        motionReduced ? 'none' : 'background-color 120ms ease, border-color 120ms ease'
      }
      _hover={selected ? undefined : { bg: 'bg.hover' }}
      _active={motionReduced ? undefined : { transform: 'translateY(1px)' }}
      css={{ '&:focus-visible': FOCUS_VISIBLE }}
    >
      {row.available ? null : (
        <Icon as={LuCircleSlash} boxSize="3" color="fg.subtle" aria-hidden="true" flexShrink={0} />
      )}

      {row.section === 'recent' ? (
        <Text
          as="span"
          fontSize="9px"
          textTransform="uppercase"
          letterSpacing="0.06em"
          color="fg.subtle"
          flexShrink={0}
        >
          {LAUNCHER_RECENT_LABEL}
        </Text>
      ) : null}

      {/* The ONE ellipsizing child; the full path stays in the group heading + name. */}
      <Text
        flex="1 1 auto"
        minWidth={0}
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
          data-testid={LAUNCHER_PALETTE_ROW_RISK_TESTID}
          display="inline-flex"
          alignItems="center"
          gap="1"
          flexShrink={0}
          px={1.5}
          py={0.5}
          borderRadius="sm"
          borderWidth="1px"
          borderColor={tint(riskVar(row.risk), 40)}
          bg={tint(riskVar(row.risk), 12)}
          color="fg.default"
        >
          <Icon as={riskIcon(row.risk)} boxSize="3" color={riskColor(row.risk)} aria-hidden="true" />
          <Text as="span" fontSize="10px" fontWeight="600" textTransform="uppercase" color="fg.default">
            {row.riskLabel}
          </Text>
        </Box>
      )}

      {row.key === null ? null : (
        <Box data-testid={LAUNCHER_PALETTE_ROW_KEY_TESTID} flexShrink={0}>
          <NavKeycap keys={[row.key]} />
        </Box>
      )}

      {selected ? (
        <Box flexShrink={0} aria-hidden="true">
          <Keycap sequence={LAUNCHER_SECONDARY_SEQUENCE} />
        </Box>
      ) : null}
    </Box>
  );
}

/** The grouped palette. */
export function LauncherNavigationList({
  model,
  selectedIndex,
  onSelect,
  reducedMotion,
  containerRef,
}: LauncherNavigationListProps): React.ReactElement {
  const hookReduced = useNavReducedMotion();
  const motionReduced = reducedMotion ?? hookReduced;
  const isEmpty = model.rows.length === 0;

  return (
    <Box
      ref={containerRef}
      id="fredo-launcher-nav-list"
      data-testid={LAUNCHER_PALETTE_LIST_TESTID}
      role="listbox"
      aria-label={LAUNCHER_PALETTE_ARIA_LABEL}
      width="100%"
      maxWidth="560px"
      maxHeight="min(52vh, 420px)"
      overflowY="auto"
      display="flex"
      flexDirection="column"
      gap={3}
      pb={2}
      css={LIST_KEYFRAMES}
      style={motionReduced ? LIST_NO_MOTION_STYLE : LIST_MOTION_STYLE}
    >
      <Text
        as="div"
        color="fg.muted"
        fontSize="11px"
        textTransform="uppercase"
        letterSpacing="0.05em"
        px={2}
        aria-hidden="true"
      >
        | PLACES
      </Text>

      {isEmpty ? (
        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap={3}
          py={8}
        >
          <Icon as={LuSearch} boxSize="7" color="fg.muted" aria-hidden="true" />
          <Text fontSize="13px" color="fg.muted">
            {LAUNCHER_PALETTE_EMPTY_COPY}
          </Text>
        </Box>
      ) : (
        model.groups.map((group, groupIndex) => {
          const headingId = `fredo-launcher-nav-group-${groupIndex}`;
          return (
            <Box
              key={group.placeId}
              role="group"
              aria-labelledby={headingId}
              data-testid={LAUNCHER_PALETTE_GROUP_TESTID}
              display="flex"
              flexDirection="column"
              gap="0.5"
              minWidth={0}
            >
              <Text
                id={headingId}
                data-testid={LAUNCHER_PALETTE_GROUP_PATH_TESTID}
                px={2}
                mb={1}
                fontSize="11px"
                fontWeight="500"
                color="fg.muted"
                letterSpacing="0.02em"
              >
                {group.pathLabel}
              </Text>
              <Box display="flex" flexDirection="column" gap="0.5" minWidth={0}>
                {group.rows.map((row) => {
                  const index = model.rows.indexOf(row);
                  return (
                    <NavigationRow
                      key={`${row.verbId}:${row.section}`}
                      row={row}
                      index={index}
                      selected={index === selectedIndex}
                      motionReduced={motionReduced}
                      onSelect={onSelect}
                    />
                  );
                })}
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}
