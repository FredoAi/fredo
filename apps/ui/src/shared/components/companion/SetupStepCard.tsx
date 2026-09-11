/**
 * SetupStepCard — one prerequisite row of the Companion setup wizard
 * (Spec #2855). Status is always icon + text (never color-only); the stable
 * QA hooks are `companion-step-<testId>` with `-status` / `-install` /
 * `-recheck` / `-retry` descendants.
 */

import React, { useEffect, useRef } from 'react';
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

export interface SetupStepCardProps {
  step: CompanionSetupStepMeta;
  uiState: SetupStepUiState;
  detail?: string;
  resolvedPath?: string | null;
  errorText?: string;
  onRunAction: (id: PrerequisiteId) => void;
  onRecheck: () => void;
}

interface CardColors {
  bg: string;
  borderColor: string;
}

function cardColors(uiState: SetupStepUiState): CardColors {
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

  const isChecking = uiState === 'checking';
  const isRunning = uiState === 'running';
  const isMissing = uiState === 'missing';
  const isInstalled = uiState === 'installed';
  const isError = uiState === 'error';

  // Move focus to the error row after a failed install (keyboard recovery).
  useEffect(() => {
    if (errorText) rowRef.current?.focus();
  }, [errorText]);

  const colors = cardColors(uiState);

  const status = (() => {
    switch (uiState) {
      case 'checking':
        return (
          <>
            <Spinner size="xs" color="fg.muted" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="fg.muted">
              Checking…
            </Text>
          </>
        );
      case 'running':
        return (
          <>
            <Spinner size="xs" color="accent.default" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="fg.default">
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
            <Text fontSize="xs" fontWeight="600" color="status.error">
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
        borderRadius="md"
        border="1px solid"
        bg={colors.bg}
        borderColor={colors.borderColor}
        p={3}
        opacity={isChecking ? 0.6 : 1}
        transition="opacity 0.2s, background 0.2s, border-color 0.2s"
        outline="none"
        _focusVisible={{ boxShadow: '0 0 0 2px var(--accent-primary)' }}
      >
        <HStack gap={3} align="flex-start">
          <Box pt="1px" flexShrink={0}>
            <Icon as={step.icon} boxSize="20px" color="fg.default" aria-hidden />
          </Box>

          <VStack align="stretch" gap={2} flex={1} minW="0">
            <HStack gap={3} align="center" wrap="wrap">
              <Text fontSize="sm" fontWeight="600" color="fg.default">
                {step.label}
              </Text>
              <HStack gap={1} align="center" data-testid={`companion-step-${step.testId}-status`}>
                {status}
              </HStack>
            </HStack>

            <Text fontSize="xs" color="fg.muted">
              {step.description}
            </Text>

            {isRunning && (
              <Box>
                <Progress.Root value={null} size="xs">
                  <Progress.Track>
                    <Progress.Range />
                  </Progress.Track>
                </Progress.Root>
              </Box>
            )}

            {detailText && !isRunning && (
              <Text
                fontSize="11px"
                fontFamily="mono"
                color={isError ? 'status.error' : 'fg.muted'}
                wordBreak="break-all"
              >
                {detailText}
              </Text>
            )}

            {isInstalled && resolvedPath && !detailText && (
              <Text fontSize="11px" fontFamily="mono" color="fg.muted" wordBreak="break-all">
                {resolvedPath}
              </Text>
            )}

            <HStack gap={2} wrap="wrap">
              {step.action && (isMissing || isRunning) && (
                <Button
                  size="sm"
                  data-testid={`companion-step-${step.testId}-install`}
                  bg="var(--accent-primary)"
                  color="white"
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
                  variant="outline"
                  data-testid={`companion-step-${step.testId}-retry`}
                  color="status.error"
                  onClick={() => onRunAction(step.id)}
                  _hover={{ bg: 'var(--hover-bg)' }}
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
                  onClick={onRecheck}
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
