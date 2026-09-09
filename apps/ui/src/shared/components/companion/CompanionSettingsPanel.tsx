import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, HStack, Text, VStack, Switch,
} from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';
import { useCompanion } from '../../contexts/CompanionContext';
import { adapterBridge } from '../../utils/adapterBridge';
import { tint } from '../../utils/colorTint';
import { useWindowActions } from '../../window-system/useWindowActions';
import { setupFeature } from '../../../features/setup';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ModelFilesCheck {
  gguf_exists: boolean;
  mmproj_exists: boolean;
}

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
  const { state, setVisible } = useCompanion();
  const { isVisible } = state;
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
            bg={tint('var(--status-error)', 12)}
            border="1px solid"
            borderColor={tint('var(--status-error)', 30)}
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
    </VStack>
  );
};
