/**
 * Theme-token swatch row (Spec #3070, ST-4, UI/UX section 2.5).
 *
 * The ten `WireframeColorToken`s rendered as 24px tiles. The document stores the
 * TOKEN NAME — never a hex — and the tile previews the exact CSS variable the
 * canvas resolves at paint time (UI/UX section 8), so the panel and the artboard
 * stay in lockstep across theme/accent changes.
 *
 * Tiles are real buttons with `aria-label` + `aria-pressed`; every tile keeps a
 * 1px `border.default` rim so `surface`/`muted` remain visible, and the selected
 * tile gets a 2px `accent.focusRing` outline with an offset.
 */

import React from 'react';
import { Flex, SimpleGrid, Text, chakra } from '@chakra-ui/react';

import { WIREFRAME_COLOR_TOKENS, type WireframeColorToken } from '../../model/elements';

/** Human names for the swatch `aria-label`s. */
export const WIREFRAME_COLOR_LABELS: Readonly<Record<WireframeColorToken, string>> = {
  surface: 'Surface',
  muted: 'Muted',
  border: 'Border',
  text: 'Text',
  textMuted: 'Muted text',
  accent: 'Accent',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  info: 'Info',
};

/**
 * Palette keys -> CSS variables (UI/UX section 8, the single colour contract).
 * Both the panel preview and the canvas read the SAME names.
 */
export const WIREFRAME_COLOR_VARS: Readonly<Record<WireframeColorToken, string>> = {
  surface: 'var(--card-bg)',
  muted: 'var(--card-hover-bg)',
  border: 'var(--border-color)',
  text: 'var(--text-primary)',
  textMuted: 'var(--text-secondary)',
  accent: 'var(--accent-primary)',
  success: 'var(--status-success)',
  warning: 'var(--status-warning)',
  error: 'var(--status-error)',
  info: 'var(--status-info)',
};

export interface SwatchRowProps {
  label: string;
  value: WireframeColorToken;
  onChange: (value: WireframeColorToken) => void;
}

export function SwatchRow({ label, value, onChange }: SwatchRowProps): React.ReactElement {
  return (
    <Flex direction="column" gap={1} minWidth={0}>
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
      <SimpleGrid columns={5} gap={2} data-testid="wireframe-fill-swatches">
        {WIREFRAME_COLOR_TOKENS.map((token) => {
          const selected = token === value;
          return (
            <chakra.button
              key={token}
              type="button"
              data-testid={`wireframe-fill-${token}`}
              data-color-token={token}
              aria-label={WIREFRAME_COLOR_LABELS[token]}
              aria-pressed={selected}
              onClick={() => onChange(token)}
              boxSize="24px"
              borderRadius="sm"
              borderWidth="1px"
              borderColor="border.default"
              bg={WIREFRAME_COLOR_VARS[token]}
              outline={selected ? '2px solid' : 'none'}
              outlineColor={selected ? 'accent.focusRing' : undefined}
              outlineOffset="2px"
              cursor="pointer"
              p={0}
              _hover={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
              _focusVisible={{
                outline: '2px solid',
                outlineColor: 'accent.focusRing',
                outlineOffset: '2px',
              }}
            />
          );
        })}
      </SimpleGrid>
    </Flex>
  );
}
