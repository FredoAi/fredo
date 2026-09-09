import React from 'react';
import { Box, SimpleGrid, Text } from '@chakra-ui/react';
import { LuAppWindow } from 'react-icons/lu';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { tint } from '../../../../shared/utils/colorTint';

/**
 * LauncherAppGrid — the selectable tile grid of Fredo's `SHOWABLE_FEATURES`.
 *
 * Presentational ONLY: it renders `entries` as a responsive grid of app tiles and
 * reports a tile selection UP to the host via `onSelect(index)`. It makes no
 * window-engine calls and never imports a feature module directly (cross-feature
 * imports are forbidden) — the grid is driven entirely by the `entries` prop.
 *
 * Selected / keyboard-focused tile: 1px accent border + `tint('var(--accent-primary)', 22)`.
 * Hover tile: `tint('var(--accent-primary)', 14)`.
 * Empty feature set: labels + a graceful `role="status"` empty state (no crash).
 */

export interface LauncherAppGridProps {
  entries: FredoFeatureClass[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

const GRID_ID = 'fredo-launcher-grid';

// Wireframe scrollbar — theme CSS vars only (thumb `var(--card-hover-bg)`, track transparent).
const GRID_SCROLLBAR_CSS = {
  '&::-webkit-scrollbar': { width: '8px', height: '8px' },
  '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
};

interface LauncherAppTileProps {
  feature: FredoFeatureClass;
  selected: boolean;
  onSelect: () => void;
}

const LauncherAppTile: React.FC<LauncherAppTileProps> = ({ feature, selected, onSelect }) => {
  const Icon = feature.icon;
  return (
    <Box role="gridcell" display="flex" justifyContent="center">
      <Box
        role="button"
        aria-label={feature.name}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap={1.5}
        width="128px"
        height="112px"
        borderRadius="8px"
        borderWidth="1px"
        borderStyle="solid"
        borderColor={selected ? 'var(--accent-primary)' : 'var(--border-color)'}
        bg={selected ? tint('var(--accent-primary)', 22) : 'var(--card-bg)'}
        cursor="pointer"
        transition="background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease"
        _hover={selected ? undefined : { bg: tint('var(--accent-primary)', 14) }}
        _active={{ transform: 'translateY(1px)' }}
        css={{ '&:focus-visible': { outline: '2px solid var(--accent-primary)', outlineOffset: '2px' } }}
      >
        <Icon size={32} />
        <Text
          color="fg.default"
          fontSize="12px"
          lineHeight="tight"
          textAlign="center"
          lineClamp={1}
          px={1}
        >
          {feature.name}
        </Text>
      </Box>
    </Box>
  );
};

export const LauncherAppGrid: React.FC<LauncherAppGridProps> = ({ entries, selectedIndex, onSelect }) => {
  return (
    <Box
      id={GRID_ID}
      role="grid"
      aria-label="Apps"
      overflowY="auto"
      display="flex"
      flexDirection="column"
      gap={3}
      borderRadius="8px"
      css={GRID_SCROLLBAR_CSS}
    >
      <Text as="div" color="fg.muted" fontSize="11px" textTransform="uppercase" letterSpacing="0.05em">
        | APPS
      </Text>

      {entries.length === 0 ? (
        <Box
          role="status"
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap={3}
          py={8}
        >
          <LuAppWindow size={28} color="var(--text-secondary)" />
          <Text color="fg.muted" fontSize="13px">
            No apps available
          </Text>
        </Box>
      ) : (
        <SimpleGrid columns={{ base: 2, sm: 3, md: 4, lg: 6 }} gap={4}>
          {entries.map((feature, index) => (
            <LauncherAppTile
              key={feature.id}
              feature={feature}
              selected={index === selectedIndex}
              onSelect={() => onSelect(index)}
            />
          ))}
        </SimpleGrid>
      )}
    </Box>
  );
};
