/**
 * Curated icon picker (Spec #3070, ST-4, R-1.5 / UI/UX section 2.5).
 *
 * A 6-column grid over the curated `WIREFRAME_ICONS` set. Every tile is a real
 * button with the icon's human label as its accessible name and `aria-pressed`
 * for its selected state; the glyph is the SAME path data the canvas renders.
 */

import React from 'react';
import { Flex, SimpleGrid, Text, chakra } from '@chakra-ui/react';

import type { WireframeIconId } from '../../model/elements';
import { WIREFRAME_ICONS } from '../../model/icons';

export interface IconPickerProps {
  value: WireframeIconId;
  onChange: (value: WireframeIconId) => void;
}

export function IconPicker({ value, onChange }: IconPickerProps): React.ReactElement {
  return (
    <Flex direction="column" gap={1} minWidth={0}>
      <Text fontSize="xs" color="fg.muted">
        Icon
      </Text>
      <SimpleGrid columns={6} gap={2} data-testid="wireframe-icon-picker">
        {WIREFRAME_ICONS.map((icon) => {
          const selected = icon.id === value;
          return (
            <chakra.button
              key={icon.id}
              type="button"
              data-testid={`wireframe-icon-${icon.id}`}
              aria-label={icon.label}
              aria-pressed={selected}
              onClick={() => onChange(icon.id)}
              display="flex"
              alignItems="center"
              justifyContent="center"
              boxSize="32px"
              borderRadius="sm"
              borderWidth="1px"
              borderColor={selected ? 'accent.focusRing' : 'border.subtle'}
              bg={selected ? 'bg.muted' : 'bg.surface'}
              color={selected ? 'accent.default' : 'fg.muted'}
              cursor="pointer"
              p={0}
              _hover={{ borderColor: 'accent.focusRing' }}
              _focusVisible={{
                outline: '2px solid',
                outlineColor: 'accent.focusRing',
                outlineOffset: '2px',
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
                focusable="false"
              >
                <path d={icon.path} fill="currentColor" />
              </svg>
            </chakra.button>
          );
        })}
      </SimpleGrid>
    </Flex>
  );
}
