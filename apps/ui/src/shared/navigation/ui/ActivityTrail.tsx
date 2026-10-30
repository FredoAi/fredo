/**
 * Spec #3118 (P4), ST-4 — `ActivityTrail`: the journal as a receipt column (AC3 / R-3.1…R-3.5).
 *
 * The trail is a PURE presentation of `ActivityTrailModel`: the model already sorts `seq`
 * DESC, caps at `CAPABILITY_LIMITS.maxJournalEntries` (10), resolves the actor label and the
 * place path, and decides undo. The component therefore NEVER synthesizes an entry, never
 * re-sorts, and never infers undo from the verb id — it renders the undo affordance iff
 * `entry.undoable` (the negative trap: `undoAffordance(verbId).disabled` is `false` for any
 * verb outside the five built-in non-undoable ids even when the entry has no inverse).
 *
 * The non-undoable explanation is plain text with no control of its own and renders only when
 * `entry.undoReason` carries content (never an empty tooltip / label).
 *
 * Attribution is textual AND structural: the actor label is rendered text and the entry
 * carries `data-nav-actor` — colour is never the only channel (R-3.4 / Q3-04).
 *
 * Motion: a single opacity/transform entrance keyframe, disabled under the host's reduced
 * motion preference (`useNavReducedMotion()`). No polling, no persistence, no `aria-live`.
 *
 * Colours: semantic theme tokens only (no hex/rgb/hsl, no `var(--x)NN` alpha-appends).
 */

import React from 'react';
import { Icon, chakra } from '@chakra-ui/react';
import { LuCircleSlash, LuCpu, LuHistory, LuSparkles } from 'react-icons/lu';

import {
  NAV_ACTOR_ATTR,
  NAV_COMPACT_ATTR,
  NAV_MOTION_MS,
  NAV_SURFACE_ATTR,
  NAV_TRAIL_ACTOR_TESTID,
  NAV_TRAIL_ARIA_LABEL,
  NAV_TRAIL_EMPTY_TESTID,
  NAV_TRAIL_ENTRY_TESTID,
  NAV_TRAIL_PATH_TESTID,
  NAV_TRAIL_TESTID,
  NAV_TRAIL_TIME_TESTID,
  NAV_TRAIL_UNDO_TESTID,
  NAV_VERB_ID_ATTR,
} from './constants';
import type { ActivityTrailEntry, ActivityTrailModel } from './types';
import { useNavReducedMotion } from './useReducedMotion';

export interface ActivityTrailProps {
  readonly model: ActivityTrailModel;
  readonly compact?: boolean;
  readonly onUndo: (seq: number) => void;
}

/**
 * The ONE entrance animation: opacity + transform only, keyed by `seq` so a newly appended
 * entry fades/slides in while older rows stay put. `reducedMotion` swaps it for `none`.
 */
const TRAIL_KEYFRAMES = `@keyframes navigation-trail-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}`;

/** The two stable per-entry hooks (`data-nav-actor`, `data-nav-verb-id`). */
function entryDataAttributes(entry: ActivityTrailEntry): Record<string, string> {
  return {
    [NAV_ACTOR_ATTR]: entry.actor,
    [NAV_VERB_ID_ATTR]: entry.verbId,
  };
}

/**
 * Actor attribution: `Companion` is a chip (text + token colours + sparkles), `System` adds a
 * CPU glyph, `human` is quiet text. The label text is always present (never colour-only).
 */
function ActorAttribution({ entry }: { readonly entry: ActivityTrailEntry }) {
  const companion = entry.actor === 'companion';
  return (
    <chakra.span
      data-testid={NAV_TRAIL_ACTOR_TESTID}
      display="inline-flex"
      alignItems="center"
      gap="1"
      flexShrink={0}
      fontSize="2xs"
      fontWeight="600"
      color={companion ? 'fg.default' : 'fg.muted'}
      {...(companion
        ? {
            bg: 'bg.subtle',
            borderWidth: '1px',
            borderColor: 'accent.border',
            borderRadius: 'sm',
            px: '1',
          }
        : {})}
    >
      {companion ? <Icon as={LuSparkles} boxSize="3" aria-hidden="true" /> : null}
      {entry.actor === 'system' ? (
        <Icon as={LuCpu} boxSize="3" aria-hidden="true" />
      ) : null}
      {entry.actorLabel}
    </chakra.span>
  );
}

/** One ledger row: actor + label + (undo iff `entry.undoable`) over path + time. */
function TrailEntry({
  entry,
  compact,
  animation,
  onUndo,
}: {
  readonly entry: ActivityTrailEntry;
  readonly compact: boolean;
  readonly animation: string;
  readonly onUndo: (seq: number) => void;
}) {
  const nonUndoableReason =
    entry.undoable === false && entry.undoReason !== null && entry.undoReason.length > 0
      ? entry.undoReason
      : null;

  return (
    <chakra.li
      role="listitem"
      data-testid={NAV_TRAIL_ENTRY_TESTID}
      {...entryDataAttributes(entry)}
      display="flex"
      flexDirection="column"
      gap="1"
      px="2"
      py={compact ? '1' : '2'}
      borderBottomWidth="1px"
      borderColor="border.subtle"
      _hover={{ bg: 'bg.hover' }}
      style={{ animation }}
    >
      <chakra.div display="flex" alignItems="center" gap="2" minWidth={0}>
        <ActorAttribution entry={entry} />
        <chakra.span
          flex="1 1 auto"
          minWidth={0}
          fontSize="xs"
          color="fg.default"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          title={entry.label}
        >
          {entry.label}
        </chakra.span>
        {entry.undoable ? (
          <chakra.button
            type="button"
            data-testid={NAV_TRAIL_UNDO_TESTID}
            onClick={() => onUndo(entry.seq)}
            aria-label={`${entry.undoLabel ?? 'Undo'} ${entry.label}`}
            flexShrink={0}
            height="24px"
            px="2"
            fontSize="2xs"
            fontWeight="600"
            color="fg.default"
            bg="transparent"
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="sm"
            cursor="pointer"
            _hover={{ bg: 'bg.hover', borderColor: 'accent.border' }}
          >
            {entry.undoLabel ?? 'Undo'}
          </chakra.button>
        ) : null}
      </chakra.div>

      {compact ? null : (
        <chakra.div display="flex" alignItems="center" gap="2" minWidth={0}>
          <chakra.span
            data-testid={NAV_TRAIL_PATH_TESTID}
            flex="1 1 auto"
            minWidth={0}
            fontSize="2xs"
            color="fg.muted"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {entry.pathLabel}
          </chakra.span>
          <chakra.span
            data-testid={NAV_TRAIL_TIME_TESTID}
            flexShrink={0}
            fontSize="2xs"
            color="fg.subtle"
            fontVariantNumeric="tabular-nums"
          >
            {entry.timeLabel}
          </chakra.span>
        </chakra.div>
      )}

      {nonUndoableReason === null ? null : (
        <chakra.div display="flex" alignItems="center" gap="1" fontSize="2xs" color="fg.muted">
          <Icon as={LuCircleSlash} boxSize="3" color="fg.subtle" aria-hidden="true" />
          <chakra.span>{nonUndoableReason}</chakra.span>
        </chakra.div>
      )}
    </chakra.li>
  );
}

/** R-3.1 … R-3.5 — the trail's ONE surface, rendered from the model and nothing else. */
export function ActivityTrail({
  model,
  compact = false,
  onUndo,
}: ActivityTrailProps): React.ReactElement {
  // `reducedMotion` gates the ONLY animation on this surface (opacity/transform entrance).
  const reducedMotion = useNavReducedMotion();
  const animation = reducedMotion ? 'none' : `navigation-trail-in ${NAV_MOTION_MS}ms ease`;

  return (
    <chakra.section
      role="region"
      aria-label={NAV_TRAIL_ARIA_LABEL}
      data-testid={NAV_TRAIL_TESTID}
      {...{ [NAV_SURFACE_ATTR]: 'trail' }}
      {...(compact ? { [NAV_COMPACT_ATTR]: 'true' } : {})}
      width="100%"
      maxWidth="360px"
      p={compact ? '2' : '3'}
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="md"
    >
      <style>{TRAIL_KEYFRAMES}</style>
      <chakra.h2 fontSize="xs" fontWeight="600" color="fg.muted" m="0" mb="2">
        {NAV_TRAIL_ARIA_LABEL}
      </chakra.h2>

      {model.empty ? (
        <chakra.div
          data-testid={NAV_TRAIL_EMPTY_TESTID}
          display="flex"
          alignItems="center"
          gap="2"
          fontSize="xs"
          color="fg.muted"
          py="6"
        >
          <Icon as={LuHistory} boxSize="3.5" color="fg.subtle" aria-hidden="true" />
          {model.emptyCopy}
        </chakra.div>
      ) : (
        <chakra.ul role="list" display="flex" flexDirection="column" m="0" p="0" listStyleType="none">
          {model.entries.map((entry) => (
            <TrailEntry
              key={entry.seq}
              entry={entry}
              compact={compact}
              animation={animation}
              onUndo={onUndo}
            />
          ))}
        </chakra.ul>
      )}
    </chakra.section>
  );
}
