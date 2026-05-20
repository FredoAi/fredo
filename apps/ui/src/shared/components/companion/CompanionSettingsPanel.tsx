import React from 'react';
import {
  Box, HStack, Text, VStack, Switch,
} from '@chakra-ui/react';
import { useCompanion } from '../../contexts/CompanionContext';

// Preset colors with labels
const PRESET_COLORS: { label: string; value: string }[] = [
  { label: 'Purple',  value: '#a855f7' },
  { label: 'Cyan',    value: '#22d3ee' },
  { label: 'Green',   value: '#4ade80' },
  { label: 'Orange',  value: '#fb923c' },
  { label: 'Pink',    value: '#f472b6' },
  { label: 'Red',     value: '#f87171' },
  { label: 'Yellow',  value: '#facc15' },
  { label: 'White',   value: '#e2e8f0' },
];

const sectionLabel = (text: string) => (
  <Text
    fontSize="xs"
    fontWeight="700"
    color="var(--text-secondary)"
    letterSpacing="wider"
    textTransform="uppercase"
    mb={2}
  >
    {text}
  </Text>
);

export const CompanionSettingsPanel: React.FC = () => {
  const { state, setVisible, setColor } = useCompanion();
  const { isVisible, color } = state;

  return (
    <VStack align="stretch" gap={6} p={6}>
      {/* Enable / Disable */}
      <Box>
        {sectionLabel('Companion')}
        <HStack
          justify="space-between"
          p={3}
          borderRadius="md"
          background="var(--hover-bg)"
          border="1px solid var(--border-color)"
        >
          <VStack align="start" gap={0}>
            <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
              Show Fredo Companion
            </Text>
            <Text fontSize="xs" color="var(--text-secondary)">
              Display the desktop buddy overlay
            </Text>
          </VStack>
          <Switch.Root
            checked={isVisible}
            onCheckedChange={(e) => setVisible(e.checked)}
            colorPalette="purple"
            size="md"
          >
            <Switch.HiddenInput />
            <Switch.Control />
          </Switch.Root>
        </HStack>
      </Box>

      {/* Teleport tip */}
      <Box
        opacity={isVisible ? 1 : 0.4}
        p={3}
        borderRadius="md"
        background="var(--hover-bg)"
        border="1px solid var(--border-color)"
      >
        {sectionLabel('Teleport')}
        <Text fontSize="xs" color="var(--text-secondary)">
          Hold{' '}
          <Text as="kbd" fontFamily="monospace" px={1} py={0.5} borderRadius="sm" background="var(--card-bg)" border="1px solid var(--border-color)">
            Ctrl
          </Text>{' '}
          and right-click anywhere to teleport Fredo there.
        </Text>
      </Box>

      {/* Color picker */}
      <Box opacity={isVisible ? 1 : 0.4} pointerEvents={isVisible ? 'auto' : 'none'}>
        {sectionLabel('Speech bubble color')}
        <HStack gap={2} flexWrap="wrap">
          {PRESET_COLORS.map((preset) => {
            const isSelected = color === preset.value;
            return (
              <Box
                key={preset.value}
                as="button"
                title={preset.label}
                onClick={() => setColor(preset.value)}
                w="28px"
                h="28px"
                borderRadius="full"
                background={preset.value}
                border={isSelected ? '3px solid var(--text-primary)' : '2px solid transparent'}
                boxShadow={isSelected ? `0 0 8px ${preset.value}` : 'none'}
                outline={isSelected ? `2px solid ${preset.value}` : 'none'}
                outlineOffset="2px"
                transition="all 0.15s"
                _hover={{ transform: 'scale(1.15)', boxShadow: `0 0 8px ${preset.value}` }}
                cursor="pointer"
                flexShrink={0}
              />
            );
          })}

          {/* Custom color input */}
          <Box position="relative" w="28px" h="28px" flexShrink={0} title="Custom color">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', border: 'none', padding: 0 }}
            />
            <Box
              w="28px"
              h="28px"
              borderRadius="full"
              background={`conic-gradient(red, yellow, lime, cyan, blue, magenta, red)`}
              border="2px solid var(--border-color)"
              pointerEvents="none"
            />
          </Box>
        </HStack>

        {/* Live preview swatch */}
        <HStack mt={3} gap={2} align="center">
          <Box
            w="14px"
            h="14px"
            borderRadius="full"
            background={color}
            boxShadow={`0 0 6px ${color}`}
          />
          <Text fontSize="xs" color="var(--text-secondary)" fontFamily="monospace">
            {color}
          </Text>
        </HStack>
      </Box>
    </VStack>
  );
};
