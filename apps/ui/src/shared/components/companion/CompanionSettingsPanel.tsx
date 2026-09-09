import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, HStack, Text, VStack, Switch,
} from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';
import { useCompanion } from '../../contexts/CompanionContext';
import { adapterBridge } from '../../utils/adapterBridge';
import { useWindowActions } from '../../window-system/useWindowActions';
import { setupFeature } from '../../../features/setup';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ModelFilesCheck {
  gguf_exists: boolean;
  mmproj_exists: boolean;
}

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
  const { openWindow } = useWindowActions();

  const [modelsExist, setModelsExist] = useState<boolean>(true);
  const [checkingModels, setCheckingModels] = useState<boolean>(true);

  // Check model files presence on mount — re-checks every time the tab is
  // switched back because React unmounts/remounts via `key={activeSection}`
  // in ProfileSettingsModal.
  useEffect(() => {
    let cancelled = false;

    async function checkModels() {
      try {
        setCheckingModels(true);
        const result = await adapterBridge.invoke<ModelFilesCheck>('check_model_files');
        if (!cancelled) {
          setModelsExist((result?.gguf_exists && result?.mmproj_exists) ?? false);
        }
      } catch (err) {
        console.error('[CompanionSettingsPanel] Failed to check model files:', err);
        if (!cancelled) {
          setModelsExist(false);
        }
      } finally {
        if (!cancelled) {
          setCheckingModels(false);
        }
      }
    }

    checkModels();
    return () => { cancelled = true; };
  }, []);

  const modelsGate = checkingModels || !modelsExist;

  const handleOpenSetup = useCallback(() => {
    openWindow({
      id: setupFeature.id,
      title: setupFeature.name,
      icon: React.createElement(setupFeature.icon as any, { size: 16 }) as React.ReactNode,
      component: setupFeature.render() as React.ReactNode,
      canClose: true,
      canMaximize: true,
      canMinimize: true,
      isMaximized: true,
    });
  }, [openWindow]);

  return (
    <VStack align="stretch" gap={6} p={6}>
      {/* Enable / Disable — gated by model files presence */}
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
            checked={isVisible && modelsExist}
            disabled={modelsGate}
            onCheckedChange={(e) => setVisible(e.checked)}
            colorPalette="purple"
            size="md"
          >
            <Switch.HiddenInput />
            <Switch.Control />
          </Switch.Root>
        </HStack>

        {/* Model-missing warning banner */}
        {!checkingModels && !modelsExist && (
          <HStack
            mt={2}
            p={3}
            borderRadius="md"
            background="var(--status-error)"
            bg="rgba(239, 68, 68, 0.12)"
            border="1px solid"
            borderColor="rgba(239, 68, 68, 0.3)"
            gap={2}
          >
            <Box flexShrink={0}>
              <LuTriangleAlert size={16} color="var(--status-error)" />
            </Box>
            <Text fontSize="sm" color="var(--text-secondary)" flex={1}>
              Model not downloaded —{' '}
              <Box
                as="button"
                display="inline"
                onClick={handleOpenSetup}
                color="var(--accent-primary)"
                textDecoration="underline"
                cursor="pointer"
                background="none"
                border="none"
                padding={0}
                fontSize="inherit"
                fontFamily="inherit"
              >
                run Setup to install
              </Box>
            </Text>
          </HStack>
        )}
      </Box>

      {/* Teleport tip */}
      <Box
        opacity={isVisible && !modelsGate ? 1 : 0.4}
        pointerEvents={isVisible && !modelsGate ? 'auto' : 'none'}
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
      <Box opacity={isVisible && !modelsGate ? 1 : 0.4} pointerEvents={isVisible && !modelsGate ? 'auto' : 'none'}>
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
