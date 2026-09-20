/**
 * BackgroundSettings — Settings → Appearance "Desktop Background" group
 * (Spec #2899 ST-4).
 *
 * A labeled thumbnail gallery (`role="radiogroup"`): every tile renders the
 * descriptor's OWN registry `css` at thumbnail scale, so the thumbnail IS the
 * result and cannot lie — the chooser and the shell backdrop consume ONE recipe
 * (NFR-6 analogue). Selection is IMMEDIATE-APPLY: the control writes straight
 * through the module-scoped `selectBackground` store and registers NO
 * `useSettingsSave` fn, so the Appearance pane keeps no Save footer — the same
 * pattern as the Theme Preset selector and `DockPositionSettings`
 * (`DockPositionSettings.tsx:15-16`).
 *
 * Keyboard (standard radiogroup): roving tabindex — the selected tile is
 * `tabIndex={0}`, all others `-1`, so Tab enters/leaves the group as one stop.
 * Arrow Left/Right move by one, Arrow Up/Down by one grid row (columns are
 * measured from the rendered layout), Home/End jump to the ends — each moves
 * focus AND selects. Tiles are real `<button>` elements, so Space/Enter
 * activation is native.
 *
 * Import discipline (Architect-binding, mirrors `DockPositionSettings.tsx:18-24`):
 * this component is HOME-owned and imports ONLY the sibling registry/store, the
 * shared `tint()`-based recipes, and Chakra primitives. It must NOT import from
 * the theming feature (the Appearance pane's colour group is literally called
 * "Backgrounds"; this group is deliberately "Desktop Background" to avoid the
 * collision — `ThemingSettings.tsx:367-376`).
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { LuCheck } from 'react-icons/lu';
import {
  BACKGROUND_DESCRIPTORS,
  NONE_BACKGROUND,
  getBackgroundDescriptor,
  type BackgroundId,
} from './backgroundRegistry';
import { hydrateBackground, selectBackground, useBackgroundId } from './backgroundStore';
import { layerBoxStyle, useBackgroundMotion } from './backgroundMotion';

/** Chooser order: the shipped `None` first (the default), then the recipes. */
const BACKGROUND_OPTIONS = [NONE_BACKGROUND, ...BACKGROUND_DESCRIPTORS] as const;

/**
 * Number of rendered grid columns, measured from the live layout (the grid is
 * `repeat(auto-fill, minmax(108px, 1fr))`, so the column count is responsive).
 * Tiles sharing the first tile's `offsetTop` are the first row.
 */
function countColumns(tiles: Array<HTMLElement | null>): number {
  const present = tiles.filter((tile): tile is HTMLElement => tile !== null);
  const firstTop = present[0]?.offsetTop;
  let columns = 0;
  for (const tile of present) {
    if (tile.offsetTop === firstTop) columns += 1;
    else break;
  }
  return Math.max(1, columns);
}

/** Local copy of the AppDock/Theming `SectionLabel` (no theming-feature import). */
const SectionLabel: React.FC<{ id?: string; children: React.ReactNode }> = ({ id, children }) => (
  <Text
    id={id}
    fontSize="xs"
    fontWeight="700"
    color="var(--text-secondary)"
    letterSpacing="wider"
    textTransform="uppercase"
    mb={2}
  >
    {children}
  </Text>
);

export const BackgroundSettings: React.FC = () => {
  const backgroundId = useBackgroundId();
  const motion = useBackgroundMotion();
  const tileRefs = useRef<Array<HTMLElement | null>>([]);

  // Restore the persisted selection at first consumer mount. Idempotent (runs
  // once module-wide) and dirty-guarded — a late hydration read can never
  // overwrite an in-flight user selection (mirrors `DockPositionSettings:80-82`).
  useEffect(() => {
    void hydrateBackground();
  }, []);

  const select = useCallback((id: BackgroundId): void => {
    void selectBackground(id);
  }, []);

  const moveFocusAndSelect = useCallback(
    (index: number): void => {
      const clamped = Math.max(0, Math.min(BACKGROUND_OPTIONS.length - 1, index));
      tileRefs.current[clamped]?.focus();
      select(BACKGROUND_OPTIONS[clamped].id);
    },
    [select],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, index: number): void => {
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          moveFocusAndSelect(index + 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          moveFocusAndSelect(index - 1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          moveFocusAndSelect(index + countColumns(tileRefs.current));
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveFocusAndSelect(index - countColumns(tileRefs.current));
          break;
        case 'Home':
          event.preventDefault();
          moveFocusAndSelect(0);
          break;
        case 'End':
          event.preventDefault();
          moveFocusAndSelect(BACKGROUND_OPTIONS.length - 1);
          break;
        default:
          break;
      }
    },
    [moveFocusAndSelect],
  );

  const headingId = 'desktop-background-heading';

  return (
    <Box p={6}>
      <SectionLabel id={headingId}>Desktop Background</SectionLabel>
      <Box
        role="radiogroup"
        aria-labelledby={headingId}
        data-testid="desktop-background-chooser"
        display="grid"
        gridTemplateColumns="repeat(auto-fill, minmax(108px, 1fr))"
        gap="10px"
      >
        {BACKGROUND_OPTIONS.map((option, index) => {
          const selected = option.id === backgroundId;
          return (
            <Box
              key={option.id}
              as="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              data-testid={`desktop-background-option-${option.id}`}
              data-selected={selected ? 'true' : 'false'}
              tabIndex={selected ? 0 : -1}
              ref={(node: HTMLElement | null) => {
                tileRefs.current[index] = node;
              }}
              onClick={() => select(option.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              position="relative"
              p={0}
              w="100%"
              borderRadius="md"
              overflow="hidden"
              bg="var(--card-bg)"
              border="1px solid"
              borderColor={selected ? 'var(--accent-strong)' : 'var(--border-color)'}
              boxShadow={selected ? '0 0 0 1px var(--accent-strong)' : 'none'}
              cursor="pointer"
              transition="border-color 120ms, box-shadow 120ms"
              _hover={{ borderColor: 'var(--accent-primary)', bg: 'var(--hover-bg)' }}
              _focusVisible={{ outline: '2px solid var(--accent-strong)', outlineOffset: '2px' }}
            >
              {/* Live preview — the tile IS the result: the descriptor's own
                  ground + layers at 16/10 scale, rendered STATICALLY (no
                  animation on the thumbnail — ST-2), decorative + non-interactive. */}
              <Box
                aria-hidden="true"
                pointerEvents="none"
                position="relative"
                w="100%"
                overflow="hidden"
                borderBottom="1px solid"
                borderColor="var(--border-color)"
                css={{ aspectRatio: '16 / 10', ...getBackgroundDescriptor(option.id).css }}
              >
                {getBackgroundDescriptor(option.id).layers.map((layer) => (
                  <Box
                    key={layer.id}
                    data-background-layer={layer.id}
                    position="absolute"
                    pointerEvents="none"
                    css={{ ...layer.css, ...layerBoxStyle(layer) }}
                  />
                ))}
              </Box>
              <Text
                data-testid={option.id === 'none' ? 'desktop-background-none' : undefined}
                fontSize="xs"
                color={selected ? 'var(--text-primary)' : 'var(--text-secondary)'}
                textAlign="center"
                py={1}
                lineHeight="short"
              >
                {option.label}
              </Text>
              {selected && (
                <Box
                  position="absolute"
                  top="6px"
                  right="6px"
                  boxSize="14px"
                  borderRadius="full"
                  bg="var(--accent-primary)"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  pointerEvents="none"
                  aria-hidden="true"
                >
                  <LuCheck size={10} color="var(--accent-contrast)" />
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      <Text fontSize="xs" color="var(--text-secondary)" mt={3} lineHeight="short">
        Renders behind your windows and never blocks clicks.
      </Text>
      {/* Display-only motion status (UI/UX §5): not a control, not focusable.
          The OS reduced-motion preference is the only motion off switch. */}
      <Text
        data-testid="desktop-background-motion-status"
        data-motion={motion}
        fontSize="xs"
        color="var(--text-secondary)"
        mt={1}
        lineHeight="short"
      >
        {motion === 'animated' ? 'Motion: on' : 'Motion: off (system reduced motion)'}
      </Text>
    </Box>
  );
};
