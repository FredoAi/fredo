/**
 * Spec #2946 ST-9 — the launcher action palette's results list (contract block 8;
 * UI/UX §4, PO#10 item 3).
 *
 * Presentational ONLY (mirrors `LauncherAppGrid`): it renders the projected
 * `LauncherActionResult` rows — action label + the CURRENT binding(s) as ST-3
 * `Keycap` chips (one renderer) + the tier tag — and reports a row selection UP
 * to the host via `onSelect(index)`. It makes no window-engine calls, runs no
 * action and imports no feature module. The host (`LauncherShell`) owns the
 * query, the selection and the run (`source: 'palette'`).
 *
 * Token hygiene: semantic tokens / CSS vars / `tint()` only — zero hex/rgba,
 * zero alpha-append onto a `var()`. The row carries `role="option"` with a
 * roving `tabIndex` (the selected row is the tab stop), so the host's
 * `aria-activedescendant` (`launcherActionEntryId`) points at a real element.
 */

import React from 'react';
import { Box, Text } from '@chakra-ui/react';
import { LuCommand } from 'react-icons/lu';
import { Keycap } from '../../../../shared/components/hotkeys/Keycap';
import { tint } from '../../../../shared/utils/colorTint';
import {
  launcherActionEntryId,
  type LauncherActionResult,
} from './launcherActionPalette';

export interface LauncherActionListProps {
  entries: readonly LauncherActionResult[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  /**
   * The list's root box. The launcher passes the SAME `gridRef` the app grid
   * uses, so the reply band's keep-out follows whichever results list is shown.
   */
  containerRef?: React.Ref<HTMLDivElement>;
}

const LIST_ID = 'fredo-launcher-action-list';

// Wireframe scrollbar — theme CSS vars only (thumb `var(--card-hover-bg)`, track transparent).
const LIST_SCROLLBAR_CSS = {
  '&::-webkit-scrollbar': { width: '8px', height: '8px' },
  '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
};

interface LauncherActionRowProps {
  entry: LauncherActionResult;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

const LauncherActionRow: React.FC<LauncherActionRowProps> = ({
  entry,
  index,
  selected,
  onSelect,
}) => (
  <Box
    role="option"
    id={launcherActionEntryId(index)}
    aria-selected={selected}
    data-testid="launcher-action-entry"
    data-action-id={entry.actionId}
    data-hotkey-tier={entry.tier}
    tabIndex={selected ? 0 : -1}
    onClick={onSelect}
    display="flex"
    alignItems="center"
    justifyContent="space-between"
    gap={3}
    px={3}
    py={2}
    borderRadius="md"
    borderWidth="1px"
    borderStyle="solid"
    borderColor={selected ? 'var(--accent-primary)' : 'transparent'}
    bg={selected ? tint('var(--accent-primary)', 22) : 'var(--card-bg)'}
    cursor="pointer"
    transition="background-color 0.15s ease, border-color 0.15s ease"
    _hover={selected ? undefined : { bg: tint('var(--accent-primary)', 14) }}
    css={{
      '&:focus-visible': { outline: '2px solid var(--accent-primary)', outlineOffset: '2px' },
    }}
  >
    <Box display="flex" alignItems="center" gap={2} minWidth={0}>
      <Text color="fg.default" fontSize="13px" lineClamp={1}>
        {entry.title}
      </Text>
      <Box
        as="span"
        data-testid="launcher-action-tier"
        flexShrink={0}
        fontSize="10px"
        textTransform="uppercase"
        letterSpacing="0.05em"
        color="fg.muted"
        bg="bg.subtle"
        borderWidth="1px"
        borderColor="border.subtle"
        borderRadius="sm"
        px={1.5}
        py={0.5}
      >
        {entry.tier === 'fredo' ? 'Global' : entry.featureId ?? 'Feature'}
      </Box>
    </Box>
    <Box display="flex" alignItems="center" gap={1} flexShrink={0}>
      {entry.bindings.length > 0 ? (
        entry.bindings.map((binding) => (
          <Box key={binding} as="span" data-testid="launcher-action-binding">
            <Keycap sequence={binding} />
          </Box>
        ))
      ) : (
        <Text data-testid="launcher-action-unbound" color="fg.muted" fontSize="11px">
          Unbound
        </Text>
      )}
    </Box>
  </Box>
);

export const LauncherActionList: React.FC<LauncherActionListProps> = ({
  entries,
  selectedIndex,
  onSelect,
  containerRef,
}) => {
  return (
    <Box
      ref={containerRef}
      id={LIST_ID}
      data-testid="launcher-action-list"
      role="listbox"
      aria-label="Actions"
      overflowY="auto"
      display="flex"
      flexDirection="column"
      gap={3}
      borderRadius="8px"
      css={LIST_SCROLLBAR_CSS}
    >
      <Text as="div" color="fg.muted" fontSize="11px" textTransform="uppercase" letterSpacing="0.05em">
        | ACTIONS
      </Text>

      {entries.length === 0 ? (
        <Box
          role="status"
          data-testid="launcher-action-empty"
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap={3}
          py={8}
        >
          <LuCommand size={28} color="var(--text-secondary)" />
          <Text color="fg.muted" fontSize="13px">
            No actions match
          </Text>
        </Box>
      ) : (
        <Box display="flex" flexDirection="column" gap={1}>
          {entries.map((entry, index) => (
            <LauncherActionRow
              key={entry.actionId}
              entry={entry}
              index={index}
              selected={index === selectedIndex}
              onSelect={() => onSelect(index)}
            />
          ))}
        </Box>
      )}
    </Box>
  );
};
