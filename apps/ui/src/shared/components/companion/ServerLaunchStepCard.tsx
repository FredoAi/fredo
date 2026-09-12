/**
 * ServerLaunchStepCard — the Companion setup wizard's `serverLaunch` step body
 * (Spec #2857). It renders in place of the generic `SetupStepCard` body for this
 * one step: the managed `llama-server` process lifecycle (not running → starting
 * → healthy, plus failed/exited) with a persistent inline error, an indeterminate
 * phase indicator, and Start/Retry/Restart + Re-check affordances.
 *
 * Status is always icon + text (never color-only). ONLY semantic theme tokens +
 * `tint()` are used — no hardcoded colors, no alpha-append onto a `var()`.
 *
 * Frozen QA hooks:
 *   step  `companion-step-server-launch` + `data-state` + `data-server-state`
 *         descendants `-status` / `-phase` / `-start` / `-retry` / `-recheck` / `-detail`
 *
 * No-hang (AC4): the client watchdog is a WAIT affordance ONLY — it never moves
 * the card to `failed`/AC4 failure copy. Only the backend verdict (a real invoke
 * rejection or `spawnFailed`/`portInUse`/`healthTimeout`) reaches `failed`.
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
  LuPlay,
  LuRefreshCw,
  LuRotateCw,
} from 'react-icons/lu';

import { tint } from '../../utils/colorTint';
import {
  llamaServerEndpoint,
  serverLaunchFailureCopy,
  SERVER_EXITED_COPY,
  SERVER_WATCHDOG_COPY,
  type LlamaServerLaunchCode,
  type PrerequisiteId,
  type ServerLaunchState,
} from './companionReadiness';
import type { CompanionSetupStepMeta } from './companionSetupSteps';
import { cardColors, type SetupStepUiState } from './SetupStepCard';

export interface ServerLaunchStepCardProps {
  step: CompanionSetupStepMeta;
  uiState: SetupStepUiState;
  detail?: string;
  resolvedPath?: string | null;
  errorText?: string;
  serverState: ServerLaunchState;
  serverPort?: number | null;
  serverCode?: LlamaServerLaunchCode | null;
  onRunAction: (id: PrerequisiteId) => void;
  onRecheck: () => void;
}

/** Client watchdog — a WAIT affordance only; never an AC4 failure transition. */
export const LAUNCH_WATCHDOG_MS = 45_000;
/** Starting-phase narration thresholds (progressive disclosure). */
export const LAUNCH_PHASE_SPAWN_MS = 800;
export const LAUNCH_PHASE_HEALTH_MS = 1_600;

function effectiveUiState(
  serverState: ServerLaunchState,
  uiState: SetupStepUiState,
): SetupStepUiState {
  if (uiState === 'checking') return 'checking';
  switch (serverState) {
    case 'healthy':
      return 'installed';
    case 'failed':
    case 'exited':
      return 'error';
    case 'starting':
      return 'running';
    default:
      // `notRunning` stays honest even when the backend probe itself failed
      // (fail-closed) — a launch failure is only ever `serverState: 'failed'`.
      return 'missing';
  }
}

export const ServerLaunchStepCard: React.FC<ServerLaunchStepCardProps> = ({
  step,
  uiState,
  detail,
  resolvedPath,
  serverState,
  serverPort,
  serverCode,
  onRunAction,
  onRecheck,
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [watchdogFired, setWatchdogFired] = useState(false);

  const effective = effectiveUiState(serverState, uiState);
  const isChecking = effective === 'checking';
  const isStarting = serverState === 'starting';
  const isHealthy = serverState === 'healthy';
  const isFailed = serverState === 'failed';
  const isExited = serverState === 'exited';
  const isError = effective === 'error';

  // Progressive phase narration while starting (named phases for unknown-duration
  // work) + the single-setTimeout watchdog. Reset when leaving `starting`.
  useEffect(() => {
    if (!isStarting) {
      setPhaseIndex(0);
      setWatchdogFired(false);
      return;
    }
    setPhaseIndex(0);
    setWatchdogFired(false);
    const toSpawn = setTimeout(() => setPhaseIndex(1), LAUNCH_PHASE_SPAWN_MS);
    const toHealth = setTimeout(() => setPhaseIndex(2), LAUNCH_PHASE_HEALTH_MS);
    const watchdog = setTimeout(() => setWatchdogFired(true), LAUNCH_WATCHDOG_MS);
    return () => {
      clearTimeout(toSpawn);
      clearTimeout(toHealth);
      clearTimeout(watchdog);
    };
  }, [isStarting]);

  // Keyboard recovery: move focus to the error group on transition (primitive dep).
  useEffect(() => {
    if (isError) rowRef.current?.focus();
  }, [isError]);

  const endpoint = llamaServerEndpoint(serverPort ?? null);
  const colors = cardColors(effective);

  const phaseCaption =
    phaseIndex === 0
      ? 'Generating launch config…'
      : phaseIndex === 1
        ? 'Starting llama-server…'
        : `Waiting for health check on ${endpoint}…`;
  const livePhaseCaption = watchdogFired ? SERVER_WATCHDOG_COPY : phaseCaption;

  const detailText: string | null = (() => {
    if (isFailed) return serverLaunchFailureCopy(serverCode, endpoint);
    if (isExited) return SERVER_EXITED_COPY;
    if (isHealthy) return resolvedPath ? `${endpoint} · ${resolvedPath}` : endpoint;
    if (!isStarting && !isChecking) {
      return detail ?? 'The companion server is not running yet.';
    }
    return null;
  })();

  const status = (() => {
    switch (effective) {
      case 'checking':
        return (
          <>
            <Spinner size="xs" color="fg.muted" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="fg.muted">
              Checking…
            </Text>
          </>
        );
      case 'installed':
        return (
          <>
            <Icon as={LuCircleCheck} boxSize="16px" color="status.success" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.success">
              Running
            </Text>
          </>
        );
      case 'running':
        return (
          <>
            <Spinner size="xs" color="accent.default" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="accent.default">
              Starting…
            </Text>
          </>
        );
      case 'error':
        return (
          <>
            <Icon as={LuCircleX} boxSize="16px" color="status.error" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.error">
              {isExited ? 'Server stopped' : 'Failed to start'}
            </Text>
          </>
        );
      default:
        return (
          <>
            <Icon as={LuCircleDashed} boxSize="16px" color="status.warning" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.warning">
              Not running
            </Text>
          </>
        );
    }
  })();

  const primaryLabel = isFailed
    ? 'Retry'
    : isExited
      ? 'Restart companion server'
      : isStarting
        ? (step.action?.runningLabel ?? 'Starting server…')
        : (step.action?.label ?? 'Start companion server');
  const primaryIcon = isFailed
    ? LuRotateCw
    : isExited
      ? LuRotateCw
      : LuPlay;
  const showPrimary = !isChecking && !isHealthy;

  return (
    <Box
      as="li"
      listStyleType="none"
      data-testid={`companion-step-${step.testId}`}
      data-state={effective}
      data-server-state={serverState}
    >
      <Box
        ref={rowRef}
        tabIndex={isError ? -1 : undefined}
        role={isError ? 'group' : undefined}
        aria-label={isError ? 'Companion server error' : undefined}
        aria-busy={isStarting || undefined}
        borderRadius="md"
        border="1px solid"
        bg={colors.bg}
        borderColor={colors.borderColor}
        p={3}
        opacity={isChecking ? 0.6 : 1}
        transition="opacity 0.2s, background 0.2s, border-color 0.2s"
        _motionReduce={{ transition: 'none' }}
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
              <HStack
                gap={1}
                align="center"
                data-testid={`companion-step-${step.testId}-status`}
              >
                {status}
              </HStack>
            </HStack>

            <Text fontSize="xs" color="fg.muted">
              {step.description}
            </Text>

            {isStarting && (
              <VStack align="stretch" gap={1}>
                <Box data-testid={`companion-step-${step.testId}-phase`}>
                  <Progress.Root
                    value={null}
                    size="xs"
                    aria-label="Companion server startup progress"
                  >
                    <Progress.Track>
                      <Progress.Range />
                    </Progress.Track>
                  </Progress.Root>
                </Box>
                <Text
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  fontSize="xs"
                  color={watchdogFired ? 'status.warning' : 'accent.default'}
                >
                  {livePhaseCaption}
                </Text>
              </VStack>
            )}

            {detailText && (
              <Text
                data-testid={`companion-step-${step.testId}-detail`}
                fontSize="11px"
                fontFamily="mono"
                color={isError ? 'status.error' : 'fg.muted'}
                wordBreak="break-all"
              >
                {detailText}
              </Text>
            )}

            <HStack gap={2} wrap="wrap">
              {showPrimary && (
                <Button
                  size="sm"
                  data-testid={`companion-step-${step.testId}${isFailed ? '-retry' : '-start'}`}
                  bg="var(--accent-primary)"
                  color="white"
                  disabled={isStarting}
                  aria-busy={isStarting || undefined}
                  onClick={() => onRunAction(step.id)}
                  _hover={{ opacity: 0.9 }}
                >
                  <Icon as={primaryIcon} boxSize="14px" mr={1} aria-hidden />
                  {primaryLabel}
                </Button>
              )}

              {/* Wait affordance — the watchdog only ever ENABLES Retry; it never
                  produces AC4 failure copy or a `failed` transition. */}
              {isStarting && watchdogFired && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`companion-step-${step.testId}-retry`}
                  color="accent.default"
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
