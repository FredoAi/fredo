import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, HStack, Text, VStack, Switch, NumberInput,
} from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';
import {
  useCompanion, MIN_IDLE_TIMEOUT_S, MAX_IDLE_TIMEOUT_S,
} from '../../contexts/CompanionContext';
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

// ── Idle auto-return control (#2853 ST-5) ────────────────────────────────────

/** Stepper increment for the idle timeout (seconds). */
const IDLE_TIMEOUT_STEP_S = 5;
const IDLE_TIMEOUT_INPUT_ID = 'companion-idle-timeout-seconds';
const IDLE_TIMEOUT_HELP_ID = 'companion-idle-timeout-help';

export const CompanionSettingsPanel: React.FC = () => {
  const {
    state, setVisible, idleTimeoutSeconds, setIdleTimeoutSeconds,
  } = useCompanion();
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

  // ── Idle auto-return duration (#2853 ST-5) ─────────────────────────────────
  // A local draft mirrors the persisted value while the user edits; the value is
  // written ONLY on commit (blur / Enter / stepper), never per keystroke.
  // `setIdleTimeoutSeconds` clamps (default 60, range [5, 3600]) so a cleared /
  // non-numeric / out-of-range entry heals instead of wedging the timer.
  const [idleDraft, setIdleDraft] = useState<string>(String(idleTimeoutSeconds));
  const idleDraftRef = useRef<string>(String(idleTimeoutSeconds));

  // Re-sync the draft whenever the persisted value changes (async load on mount,
  // or a clamp applied on commit). The ref keeps stepper commits from going stale.
  useEffect(() => {
    const next = String(idleTimeoutSeconds);
    idleDraftRef.current = next;
    setIdleDraft(next);
  }, [idleTimeoutSeconds]);

  const handleIdleChange = useCallback((value: string) => {
    idleDraftRef.current = value;
    setIdleDraft(value);
  }, []);

  const commitIdleTimeout = useCallback((raw: string) => {
    // NaN / empty (Number('') === 0) / non-positive → default; else round + clamp.
    setIdleTimeoutSeconds(Number(raw));
  }, [setIdleTimeoutSeconds]);

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

        {/* Idle auto-return duration — #2853 ST-5. Gated by model files presence
            (reduced opacity + non-interactive), mirroring the Teleport tip —
            expected, not an error state. */}
        <HStack
          mt={2}
          justify="space-between"
          p={3}
          borderRadius="md"
          background="var(--hover-bg)"
          border="1px solid var(--border-color)"
          opacity={modelsGate ? 0.4 : 1}
          pointerEvents={modelsGate ? 'none' : 'auto'}
        >
          <VStack align="start" gap={0}>
            <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
              Auto-return after inactivity
            </Text>
            <Text id={IDLE_TIMEOUT_HELP_ID} fontSize="xs" color="var(--text-secondary)">
              Fredo returns to the desktop after this many seconds without interaction.
            </Text>
          </VStack>
          <HStack gap={1} align="center" flexShrink={0}>
            <NumberInput.Root
              value={idleDraft}
              onValueChange={(e) => handleIdleChange(e.value)}
              onValueCommit={(e) => commitIdleTimeout(e.value)}
              min={MIN_IDLE_TIMEOUT_S}
              max={MAX_IDLE_TIMEOUT_S}
              step={IDLE_TIMEOUT_STEP_S}
              size="sm"
              width="110px"
              disabled={modelsGate}
            >
              {/* Zag only invokes onValueCommit on blur/Enter, so persist the
                  latest value explicitly when the stepper control is clicked. */}
              <NumberInput.Control onClick={() => commitIdleTimeout(idleDraftRef.current)} />
              <NumberInput.Input
                id={IDLE_TIMEOUT_INPUT_ID}
                aria-label="Auto-return after inactivity (seconds)"
                aria-describedby={IDLE_TIMEOUT_HELP_ID}
                bg="var(--card-bg)"
                color="var(--text-primary)"
                borderColor="var(--border-color)"
                _hover={{ borderColor: 'var(--accent-primary)' }}
                _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
              />
            </NumberInput.Root>
            <Text as="span" fontSize="sm" color="var(--text-secondary)">
              s
            </Text>
          </HStack>
        </HStack>
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
