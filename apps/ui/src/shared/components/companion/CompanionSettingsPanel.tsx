import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, HStack, Text, VStack, Switch, NumberInput,
} from '@chakra-ui/react';
import {
  useCompanion, MIN_IDLE_TIMEOUT_S, MAX_IDLE_TIMEOUT_S,
} from '../../contexts/CompanionContext';
import { CompanionSetupWizard } from './CompanionSetupWizard';
import type { CompanionSetupWizardPrerequisite } from './CompanionSetupWizard';
import { COMPANION_SETUP_STEPS } from './companionSetupSteps';
import { useCompanionReadiness } from './useCompanionReadiness';
import type { PrerequisiteUiState } from './companionReadiness';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

  // Readiness gate (#2855): the backend is authoritative. While not ready — and
  // while the first probe is still in flight — the wizard is the ONLY content.
  const {
    readiness, checking, refresh, runAction, runningActionId, actionError,
  } = useCompanionReadiness();

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

  const isReady = !checking && readiness?.ready === true;

  if (!isReady) {
    // While checking (or not ready), render ONLY the wizard — never the toggle
    // or the Teleport tip (AC-1 / REQ-6). During the first probe, derive the
    // steps from the registry so each row shows its `checking` state.
    const prerequisites: CompanionSetupWizardPrerequisite[] = checking
      ? COMPANION_SETUP_STEPS.map((step) => ({
          id: step.id,
          uiState: 'checking' as PrerequisiteUiState,
        }))
      : (readiness?.prerequisites ?? []).map((p) => ({
          id: p.id,
          uiState: p.state as PrerequisiteUiState,
          detail: p.detail,
          resolvedPath: p.resolvedPath,
        }));

    return (
      <CompanionSetupWizard
        prerequisites={prerequisites}
        runningActionId={runningActionId}
        actionError={actionError}
        onRunAction={(id) => { void runAction(id); }}
        onRecheck={() => { void refresh(); }}
      />
    );
  }

  return (
    <VStack data-testid="companion-controls" align="stretch" gap={6} p={6}>
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

        {/* Idle auto-return duration — #2853 ST-5. */}
        <HStack
          mt={2}
          justify="space-between"
          p={3}
          borderRadius="md"
          background="var(--hover-bg)"
          border="1px solid var(--border-color)"
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
        opacity={isVisible ? 1 : 0.4}
        pointerEvents={isVisible ? 'auto' : 'none'}
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
