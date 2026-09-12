import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, HStack, Heading, Icon, Text, VStack, Switch, NumberInput,
} from '@chakra-ui/react';
import { LuBot } from 'react-icons/lu';
import {
  useCompanion, MIN_IDLE_TIMEOUT_S, MAX_IDLE_TIMEOUT_S, clampIdleTimeout,
} from '../../contexts/CompanionContext';
import { CompanionSetupWizard } from './CompanionSetupWizard';
import type { CompanionSetupWizardPrerequisite } from './CompanionSetupWizard';
import { COMPANION_SETUP_STEPS } from './companionSetupSteps';
import { useCompanionReadiness } from './useCompanionReadiness';
import type { PrerequisiteUiState } from './companionReadiness';

// ── Helpers ──────────────────────────────────────────────────────────────────

const COMPANION_SETTINGS_HEADING_ID = 'companion-settings-heading';

/** Uppercase mini-label for a settings group — a label, never a heading (#2864 H4). */
const sectionLabel = (text: string) => (
  <Text
    fontSize="xs"
    fontWeight="700"
    color="var(--text-subtle)"
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
/** How long the transient commit confirmation stays in the live region. */
const IDLE_COMMIT_CONFIRMATION_MS = 2500;

export const CompanionSettingsPanel: React.FC = () => {
  const {
    state, setVisible, idleTimeoutSeconds, setIdleTimeoutSeconds,
  } = useCompanion();
  const { isVisible } = state;

  // Readiness gate (#2855): the backend is authoritative. While not ready — and
  // while the first probe is still in flight — the wizard is the ONLY content.
  const {
    readiness, checking, refresh, runAction, runningActionId, actionError, modelFiles,
    serverLaunch,
  } = useCompanionReadiness();

  // ── Idle auto-return duration (#2853 ST-5) ─────────────────────────────────
  // A local draft mirrors the persisted value while the user edits; the value is
  // written ONLY on commit (blur / Enter / stepper), never per keystroke.
  // `setIdleTimeoutSeconds` clamps (default 60, range [5, 3600]) so a cleared /
  // non-numeric / out-of-range entry heals instead of wedging the timer.
  const [idleDraft, setIdleDraft] = useState<string>(String(idleTimeoutSeconds));
  const idleDraftRef = useRef<string>(String(idleTimeoutSeconds));
  // Transient commit confirmation announced via the polite live region (#2864 ST-3).
  const [idleCommitMessage, setIdleCommitMessage] = useState('');

  // Re-sync the draft whenever the persisted value changes (async load on mount,
  // or a clamp applied on commit). The ref keeps stepper commits from going stale.
  useEffect(() => {
    const next = String(idleTimeoutSeconds);
    idleDraftRef.current = next;
    setIdleDraft(next);
  }, [idleTimeoutSeconds]);

  // Clear the transient confirmation shortly after a commit announces it.
  useEffect(() => {
    if (!idleCommitMessage) return undefined;
    const timer = setTimeout(() => setIdleCommitMessage(''), IDLE_COMMIT_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [idleCommitMessage]);

  const handleIdleChange = useCallback((value: string) => {
    idleDraftRef.current = value;
    setIdleDraft(value);
  }, []);

  const commitIdleTimeout = useCallback((raw: string) => {
    // NaN / empty (Number('') === 0) / non-positive → default; else round + clamp.
    // `clampIdleTimeout` is the exact guard `setIdleTimeoutSeconds` applies, so the
    // announced value is the value that was persisted.
    const resolved = clampIdleTimeout(Number(raw));
    setIdleTimeoutSeconds(resolved);
    setIdleCommitMessage(`Auto-return set to ${resolved} s`);
  }, [setIdleTimeoutSeconds]);

  const isReady = !checking && readiness?.ready === true;

  // Invalid draft: non-numeric / cleared (Number('') === 0) / outside [5, 3600].
  // The clamp still heals the persisted value on commit; this only drives the
  // visible editing treatment (H8).
  const parsedIdleDraft = Number(idleDraft);
  const isIdleDraftInvalid = !Number.isFinite(parsedIdleDraft)
    || parsedIdleDraft < MIN_IDLE_TIMEOUT_S
    || parsedIdleDraft > MAX_IDLE_TIMEOUT_S;
  const idleBorderColor = isIdleDraftInvalid ? 'var(--status-error)' : 'var(--border-color)';
  const idleHighlightColor = isIdleDraftInvalid ? 'var(--status-error)' : 'var(--accent-primary)';

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
        modelFiles={modelFiles}
        serverLaunch={serverLaunch}
        onRunAction={(id) => { void runAction(id); }}
        onRecheck={() => { void refresh(); }}
      />
    );
  }

  return (
    <VStack
      as="section"
      aria-labelledby={COMPANION_SETTINGS_HEADING_ID}
      data-testid="companion-controls"
      align="stretch"
      gap={6}
      p={6}
    >
      {/* Section header (#2864 H4/F7 — unified `Heading as="h2"` + accent icon). */}
      <VStack align="stretch" gap={1}>
        <HStack gap={3}>
          <Icon as={LuBot} boxSize="22px" color="var(--accent-primary)" aria-hidden />
          <Heading
            id={COMPANION_SETTINGS_HEADING_ID}
            as="h2"
            size="md"
            color="var(--text-primary)"
            fontFamily="heading"
          >
            Companion
          </Heading>
        </HStack>
        <Text fontSize="sm" color="var(--text-subtle)">
          Show or hide the desktop buddy and set how it behaves.
        </Text>
      </VStack>

      {/* Behavior group — toggle + auto-return. */}
      <Box>
        {sectionLabel('Behavior')}
        <VStack align="stretch" gap={2}>
          {/* Enable / Disable */}
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
              <Text fontSize="xs" color="var(--text-subtle)">
                Display the desktop buddy overlay
              </Text>
            </VStack>
            <Switch.Root
              checked={isVisible}
              onCheckedChange={(e) => setVisible(e.checked)}
              colorPalette="accent"
              size="md"
            >
              <Switch.HiddenInput aria-label="Show Fredo Companion" />
              <Switch.Control
                bg="var(--border-color)"
                _checked={{ bg: 'var(--accent-primary)' }}
                _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '2px' }}
              >
                <Switch.Thumb bg="var(--card-bg)" _checked={{ bg: 'var(--card-bg)' }} />
              </Switch.Control>
            </Switch.Root>
          </HStack>

          {/* Idle auto-return duration — #2853 ST-5. */}
          <HStack
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
              <Text
                id={IDLE_TIMEOUT_HELP_ID}
                fontSize="xs"
                color={isIdleDraftInvalid ? 'var(--status-error)' : 'var(--text-subtle)'}
              >
                {isIdleDraftInvalid
                  ? `Enter ${MIN_IDLE_TIMEOUT_S}–${MAX_IDLE_TIMEOUT_S} s`
                  : 'Fredo returns to the desktop after this many seconds without interaction.'}
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
                  aria-invalid={isIdleDraftInvalid}
                  bg="var(--card-bg)"
                  color="var(--text-primary)"
                  borderColor={idleBorderColor}
                  _hover={{ borderColor: idleHighlightColor }}
                  _focus={{
                    borderColor: idleHighlightColor,
                    boxShadow: `0 0 0 1px ${idleHighlightColor}`,
                  }}
                />
              </NumberInput.Root>
              <Text as="span" fontSize="sm" color="var(--text-subtle)">
                s
              </Text>
            </HStack>
          </HStack>

          {/* Transient commit confirmation (#2864 ST-3, REQ-8) — polite live region. */}
          <Text
            role="status"
            aria-live="polite"
            aria-atomic="true"
            fontSize="xs"
            color="var(--text-subtle)"
          >
            {idleCommitMessage}
          </Text>
        </VStack>
      </Box>

      {/* Teleport tip — always full contrast (#2864 H6: no dimming, ever). */}
      <Box
        p={3}
        borderRadius="md"
        background="var(--hover-bg)"
        border="1px solid var(--border-color)"
      >
        {sectionLabel('Teleport')}
        <Text fontSize="xs" color="var(--text-subtle)">
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
