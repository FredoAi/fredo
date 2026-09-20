/**
 * SetupStepCard — one prerequisite row of the Companion setup wizard
 * (Spec #2855). Status is always icon + text (never color-only); the stable
 * QA hooks are `companion-step-<testId>` with `-status` / `-install` /
 * `-recheck` / `-retry` descendants.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  HStack,
  Icon,
  Progress,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuCircleCheck,
  LuCircleDashed,
  LuCircleX,
  LuDownload,
  LuRefreshCw,
} from 'react-icons/lu';

import { tint } from '../../utils/colorTint';
import type { PrerequisiteId, PrerequisiteUiState } from './companionReadiness';
import type { CompanionSetupStepMeta } from './companionSetupSteps';

export type SetupStepUiState = PrerequisiteUiState | 'running';

/**
 * Install narration phases (#2865 §2.5) — the unknown-duration install step gets
 * the same live-narration affordance the server launch already has, so the
 * screen is never static while work is in flight. Progressive-disclosure timers.
 */
export const INSTALL_PHASE_VERIFY_MS = 1_500;
export const INSTALL_PHASE_REGISTER_MS = 3_000;
const INSTALL_PHASES = ['Downloading runtime…', 'Verifying…', 'Registering…'] as const;

/** Small-text color for the card surface (neutral vs status-tinted). */
function textOnSurface(tinted: boolean): string {
  return tinted ? 'var(--text-primary)' : 'var(--text-subtle)';
}

export interface SetupStepCardProps {
  step: CompanionSetupStepMeta;
  uiState: SetupStepUiState;
  detail?: string;
  resolvedPath?: string | null;
  errorText?: string;
  onRunAction: (id: PrerequisiteId) => void;
  onRecheck: () => void;
}

export interface CardColors {
  bg: string;
  borderColor: string;
}

export function cardColors(uiState: SetupStepUiState): CardColors {
  switch (uiState) {
    case 'running':
      return {
        bg: tint('var(--accent-primary)', 8),
        borderColor: tint('var(--accent-primary)', 30),
      };
    case 'installed':
      return {
        bg: tint('var(--status-success)', 10),
        borderColor: tint('var(--status-success)', 30),
      };
    case 'error':
      return {
        bg: tint('var(--status-error)', 12),
        borderColor: tint('var(--status-error)', 30),
      };
    default:
      return { bg: 'var(--card-bg)', borderColor: 'var(--border-color)' };
  }
}

export const SetupStepCard: React.FC<SetupStepCardProps> = ({
  step,
  uiState,
  detail,
  resolvedPath,
  errorText,
  onRunAction,
  onRecheck,
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [installPhase, setInstallPhase] = useState(0);

  const isChecking = uiState === 'checking';
  const isRunning = uiState === 'running';
  const isMissing = uiState === 'missing';
  const isInstalled = uiState === 'installed';
  const isError = uiState === 'error';
  const isInstall = step.action?.kind === 'install';
  // Status-tinted surfaces need `var(--text-primary)` for 11-12px text; neutral
  // surfaces use `var(--text-subtle)` (never `--text-secondary`/`fg.muted`).
  const tintedSurface = isRunning || isInstalled || isError;

  // Move focus to the error row after a failed install (keyboard recovery).
  useEffect(() => {
    if (errorText) rowRef.current?.focus();
  }, [errorText]);

  // Live install narration while work is in flight (never a static screen).
  useEffect(() => {
    if (!isRunning || !isInstall) {
      setInstallPhase(0);
      return undefined;
    }
    setInstallPhase(0);
    const toVerify = setTimeout(() => setInstallPhase(1), INSTALL_PHASE_VERIFY_MS);
    const toRegister = setTimeout(() => setInstallPhase(2), INSTALL_PHASE_REGISTER_MS);
    return () => {
      clearTimeout(toVerify);
      clearTimeout(toRegister);
    };
  }, [isRunning, isInstall]);

  const colors = cardColors(uiState);

  const status = (() => {
    switch (uiState) {
      case 'checking':
        return (
          <>
            <Spinner size="xs" color="var(--text-subtle)" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="var(--text-primary)">
              Checking…
            </Text>
          </>
        );
      case 'running':
        return (
          <>
            <Spinner size="xs" color="accent.default" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="var(--text-primary)">
              {step.action?.runningLabel ?? 'Working…'}
            </Text>
          </>
        );
      case 'installed':
        return (
          <>
            <Icon as={LuCircleCheck} boxSize="16px" color="status.success" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.success">
              Installed
            </Text>
          </>
        );
      case 'error':
        return (
          <>
            <Icon as={LuCircleX} boxSize="16px" color="status.error" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="var(--text-primary)">
              Failed
            </Text>
          </>
        );
      default:
        return (
          <>
            <Icon as={LuCircleDashed} boxSize="16px" color="status.warning" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.warning">
              Not installed
            </Text>
          </>
        );
    }
  })();

  const detailText = isError ? errorText ?? detail : detail;

  return (
    <Box as="li" listStyleType="none" data-testid={`companion-step-${step.testId}`} data-state={uiState}>
      <Box
        ref={rowRef}
        tabIndex={errorText ? -1 : undefined}
        role={isError ? 'group' : undefined}
        aria-label={isError ? `${step.label} installation error` : undefined}
        borderRadius="lg"
        border="1px solid"
        bg={colors.bg}
        borderColor={colors.borderColor}
        p={4}
        transition="background 0.2s, border-color 0.2s"
        _motionReduce={{ transition: 'none' }}
        outline="none"
        _focusVisible={{ boxShadow: '0 0 0 2px var(--accent-primary)' }}
      >
        <HStack gap={3} align="flex-start">
          <Box pt="1px" flexShrink={0}>
            <Icon as={step.icon} boxSize="20px" color="var(--text-primary)" aria-hidden />
          </Box>

          <VStack align="stretch" gap={2} flex={1} minW="0">
            <HStack gap={3} align="center" wrap="wrap">
              <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                {step.label}
              </Text>
              <HStack gap={1} align="center" data-testid={`companion-step-${step.testId}-status`}>
                {status}
              </HStack>
            </HStack>

            <Text fontSize="xs" color={textOnSurface(tintedSurface)}>
              {step.description}
            </Text>

            {isRunning && (
              <VStack align="stretch" gap={1}>
                <Box aria-busy="true">
                  <Progress.Root value={null} size="xs">
                    <Progress.Track>
                      <Progress.Range />
                    </Progress.Track>
                  </Progress.Root>
                </Box>
                {isInstall && (
                  <Text
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    data-testid={`companion-step-${step.testId}-phase`}
                    fontSize="xs"
                    color="var(--text-primary)"
                  >
                    {INSTALL_PHASES[installPhase]}
                  </Text>
                )}
              </VStack>
            )}

            {detailText && !isRunning && (
              <Text
                fontSize="11px"
                fontFamily="mono"
                color={textOnSurface(tintedSurface)}
                wordBreak="break-all"
              >
                {detailText}
              </Text>
            )}

            {isInstalled && resolvedPath && !detailText && (
              <Text
                fontSize="11px"
                fontFamily="mono"
                color={textOnSurface(tintedSurface)}
                wordBreak="break-all"
              >
                {resolvedPath}
              </Text>
            )}

            <HStack gap={2} wrap="wrap">
              {step.action && (isMissing || isRunning) && (
                <Button
                  size="sm"
                  data-testid={`companion-step-${step.testId}-install`}
                  bg="var(--accent-primary)"
                  color="var(--accent-contrast)"
                  disabled={isRunning}
                  aria-busy={isRunning || undefined}
                  onClick={() => onRunAction(step.id)}
                  _hover={{ opacity: 0.9 }}
                >
                  <Icon as={LuDownload} boxSize="14px" mr={1} aria-hidden />
                  {isRunning ? step.action.runningLabel : step.action.label}
                </Button>
              )}

              {step.action && isError && (
                <Button
                  size="sm"
                  data-testid={`companion-step-${step.testId}-retry`}
                  bg="var(--accent-primary)"
                  color="var(--accent-contrast)"
                  onClick={() => onRunAction(step.id)}
                  _hover={{ opacity: 0.9 }}
                >
                  <Icon as={LuRefreshCw} boxSize="14px" mr={1} aria-hidden />
                  Retry
                </Button>
              )}

              {!isChecking && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`companion-step-${step.testId}-recheck`}
                  color="var(--text-primary)"
                  onClick={onRecheck}
                  _hover={{ bg: 'var(--hover-bg)' }}
                >
                  <Icon as={LuRefreshCw} boxSize="14px" mr={1} aria-hidden />
                  Re-check
                </Button>
              )}
            </HStack>
          </VStack>
        </HStack>
      </Box>
    </Box>
  );
};
