/**
 * ModelFilesStepCard — the Companion setup wizard's `modelFiles` step body
 * (Spec #2856). It renders in place of the generic `SetupStepCard` body for this
 * one step: the three required files listed individually with per-file state,
 * live determinate progress for the in-flight file, a persistent inline error +
 * per-file Retry, and an incomplete summary that names the missing file(s).
 *
 * Status is always icon + text (never color-only). ONLY semantic theme tokens +
 * `tint()` are used — no hardcoded colors, no alpha-append onto a `var()`.
 *
 * Frozen QA hooks:
 *   step  `companion-step-model-files` + `-status` / `-summary` / `-download` / `-recheck`
 *   file  `companion-model-file-{model|vision|mtp}` + `-status` / `-progress` / `-retry`
 *         and `data-state` on each row.
 *
 * NO Cancel control ships (architect decision, G-023).
 */

import React, { useEffect, useMemo, useRef } from 'react';
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
import type {
  ModelFileId,
  ModelFileState,
  ModelFileStatus,
  ModelFilesStatus,
  PrerequisiteId,
} from './companionReadiness';
import type { CompanionSetupStepMeta } from './companionSetupSteps';
import { cardColors, type SetupStepUiState } from './SetupStepCard';

export interface ModelFilesStepCardProps {
  step: CompanionSetupStepMeta;
  uiState: SetupStepUiState;
  detail?: string;
  errorText?: string;
  modelFiles: ModelFilesStatus | null;
  onRunAction: (id: PrerequisiteId) => void;
  onRecheck: () => void;
}

interface ModelFileRosterEntry {
  id: ModelFileId;
  role: string;
  filename: string;
}

/** Fixed role/filename set — no selection UI (UI/UX §1). */
const MODEL_FILE_ROSTER: readonly ModelFileRosterEntry[] = [
  { id: 'model', role: 'Model (text)', filename: 'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf' },
  { id: 'vision', role: 'Vision projector', filename: 'mmproj-BF16.gguf' },
  {
    id: 'mtp',
    role: 'Speculative draft (MTP)',
    filename: 'MTP/mtp-gemma-4-E2B-it-Q4_0.gguf',
  },
];

/** Step-level presentation state (UI/UX §2). `missing` is the degraded state
 *  used only while per-file status is unavailable (pre-#2856 backend shape). */
type ModelStepState =
  | 'checking'
  | 'complete'
  | 'downloading'
  | 'error'
  | 'incomplete'
  | 'missing';

function rosterEntry(id: ModelFileId): ModelFileRosterEntry {
  return MODEL_FILE_ROSTER.find((entry) => entry.id === id) ?? MODEL_FILE_ROSTER[0];
}

function emptyFile(entry: ModelFileRosterEntry): ModelFileStatus {
  return {
    id: entry.id,
    filename: entry.filename,
    relativePath: entry.filename,
    state: 'missing',
    downloadedBytes: 0,
    expectedBytes: 0,
    detail: null,
    path: null,
  };
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const decimals = i === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

function toCardState(state: ModelStepState): SetupStepUiState {
  switch (state) {
    case 'checking':
      return 'checking';
    case 'complete':
      return 'installed';
    case 'downloading':
      return 'running';
    case 'error':
      return 'error';
    default:
      return 'missing';
  }
}

interface RowColors {
  bg: string;
  borderColor: string;
}

function fileRowColors(state: ModelFileState): RowColors {
  switch (state) {
    case 'downloading':
      return {
        bg: tint('var(--accent-primary)', 8),
        borderColor: tint('var(--accent-primary)', 30),
      };
    case 'present':
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

interface SummaryPart {
  text: string;
  mono?: boolean;
}

/**
 * Build the incomplete summary that NAMES the missing/truncated/error file(s)
 * (AC3 / UI/UX §6). Order: downloading, missing, interrupted, failed.
 */
function buildSummaryParts(files: ModelFileStatus[]): SummaryPart[] {
  const total = files.length;
  const present = files.filter((file) => file.state === 'present').length;
  if (total > 0 && present === total) {
    return [{ text: `Complete — all ${total} model files are present.` }];
  }
  const allAbsent =
    present === 0 &&
    files.every((file) => file.state === 'missing' && file.downloadedBytes <= 0);
  if (allAbsent) {
    return [{ text: `Incomplete — no model files downloaded yet (0 of ${total}).` }];
  }

  const segments: SummaryPart[] = [];
  const pushNamed = (
    label: string,
    named: ModelFileStatus[],
    suffix?: string,
  ): void => {
    if (named.length === 0) return;
    if (segments.length > 0) segments.push({ text: '; ' });
    segments.push({ text: `${label}: ` });
    named.forEach((file, index) => {
      if (index > 0) segments.push({ text: ', ' });
      segments.push({ text: rosterEntry(file.id).filename, mono: true });
    });
    if (suffix) segments.push({ text: suffix });
  };

  pushNamed(
    'downloading',
    files.filter((file) => file.state === 'downloading'),
  );
  pushNamed(
    'missing',
    files.filter((file) => file.state === 'missing' && file.downloadedBytes <= 0),
  );
  pushNamed(
    'incomplete',
    files.filter((file) => file.state === 'missing' && file.downloadedBytes > 0),
    ' (interrupted download)',
  );
  pushNamed(
    'failed',
    files.filter((file) => file.state === 'error'),
  );

  if (segments.length === 0) {
    return [{ text: `Incomplete — ${present} of ${total} model files present.` }];
  }
  return [{ text: 'Incomplete — ' }, ...segments, { text: '.' }];
}

export const ModelFilesStepCard: React.FC<ModelFilesStepCardProps> = ({
  step,
  uiState,
  detail,
  errorText,
  modelFiles,
  onRunAction,
  onRecheck,
}) => {
  const rowRefs = useRef<Partial<Record<ModelFileId, HTMLDivElement | null>>>({});

  const displayFiles = useMemo<ModelFileStatus[]>(
    () =>
      MODEL_FILE_ROSTER.map(
        (entry) =>
          modelFiles?.files.find((file) => file.id === entry.id) ?? emptyFile(entry),
      ),
    [modelFiles],
  );

  const stepState = useMemo<ModelStepState>(() => {
    if (uiState === 'checking') return 'checking';
    if (uiState === 'error') return 'error';
    if (uiState === 'running') return 'downloading';

    const files = modelFiles?.files ?? [];
    if (files.length > 0) {
      if (files.every((file) => file.state === 'present')) return 'complete';
      if (files.some((file) => file.state === 'downloading')) return 'downloading';
      if (files.some((file) => file.state === 'error')) return 'error';
      return 'incomplete';
    }
    // Per-file status unavailable (pre-#2856 shape / probe failed): degrade to
    // the prerequisite vocabulary; never fabricate complete.
    return uiState === 'installed' ? 'complete' : 'missing';
  }, [uiState, modelFiles]);

  const presentCount = displayFiles.filter((file) => file.state === 'present').length;
  const downloadingCount = displayFiles.filter(
    (file) => file.state === 'downloading',
  ).length;
  const firstErrorId =
    displayFiles.find((file) => file.state === 'error')?.id ?? null;

  // Keyboard recovery: move focus to the errored row on transition (primitive dep).
  useEffect(() => {
    if (firstErrorId) rowRefs.current[firstErrorId]?.focus();
  }, [firstErrorId]);

  const isChecking = stepState === 'checking';
  const isDownloading = stepState === 'downloading';
  const colors = cardColors(toCardState(stepState));
  const totalCount = displayFiles.length;
  const summary = useMemo(() => buildSummaryParts(displayFiles), [displayFiles]);

  const chip = (() => {
    switch (stepState) {
      case 'checking':
        return (
          <>
            <Spinner size="xs" color="fg.muted" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="fg.muted">
              Checking…
            </Text>
          </>
        );
      case 'complete':
        return (
          <>
            <Icon as={LuCircleCheck} boxSize="16px" color="status.success" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.success">
              {presentCount} of {totalCount} present
            </Text>
          </>
        );
      case 'downloading':
        return (
          <>
            <Spinner size="xs" color="accent.default" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="accent.default">
              Downloading {presentCount + downloadingCount} of {totalCount}…
            </Text>
          </>
        );
      case 'error':
        return (
          <>
            <Icon as={LuCircleX} boxSize="16px" color="status.error" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.error">
              Download failed
            </Text>
          </>
        );
      default:
        return (
          <>
            <Icon as={LuCircleDashed} boxSize="16px" color="status.warning" aria-hidden />
            <Text fontSize="xs" fontWeight="600" color="status.warning">
              {presentCount} of {totalCount} present
            </Text>
          </>
        );
    }
  })();

  const summaryIcon =
    stepState === 'complete'
      ? LuCircleCheck
      : stepState === 'error'
        ? LuCircleX
        : stepState === 'downloading'
          ? LuDownload
          : LuCircleDashed;
  const summaryColor =
    stepState === 'complete'
      ? 'status.success'
      : stepState === 'error'
        ? 'status.error'
        : stepState === 'downloading'
          ? 'accent.default'
          : 'status.warning';

  return (
    <Box
      as="li"
      listStyleType="none"
      data-testid={`companion-step-${step.testId}`}
      data-state={stepState}
    >
      <Box
        borderRadius="md"
        border="1px solid"
        bg={colors.bg}
        borderColor={colors.borderColor}
        p={3}
        opacity={isChecking ? 0.6 : 1}
        transition="opacity 0.2s, background 0.2s, border-color 0.2s"
      >
        <VStack align="stretch" gap={3}>
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
                  {chip}
                </HStack>
              </HStack>

              <Text fontSize="xs" color="fg.muted">
                {step.description}
              </Text>

              <HStack
                role="status"
                aria-live="polite"
                aria-atomic="true"
                data-testid={`companion-step-${step.testId}-summary`}
                gap={1}
                align="flex-start"
              >
                <Icon
                  as={summaryIcon}
                  boxSize="14px"
                  color={summaryColor}
                  aria-hidden
                  mt="1px"
                  flexShrink={0}
                />
                <Text as="span" fontSize="xs" color={summaryColor} flex={1} minW="0">
                  {summary.map((part, index) =>
                    part.mono ? (
                      <Text
                        as="span"
                        key={index}
                        fontFamily="mono"
                        wordBreak="break-all"
                      >
                        {part.text}
                      </Text>
                    ) : (
                      <React.Fragment key={index}>{part.text}</React.Fragment>
                    ),
                  )}
                </Text>
              </HStack>
            </VStack>
          </HStack>

          <VStack align="stretch" gap={2}>
            {displayFiles.map((file) => {
              const entry = rosterEntry(file.id);
              const state = file.state;
              const rowColors = fileRowColors(state);
              const expected = file.expectedBytes;
              const downloaded = file.downloadedBytes;
              const percent =
                expected > 0 ? clampPercent((downloaded / expected) * 100) : 0;
              const displayPercent = Math.round(percent);
              const isFileError = state === 'error';
              return (
                <Box
                  key={entry.id}
                  ref={(element: HTMLDivElement | null) => {
                    rowRefs.current[entry.id] = element;
                  }}
                  tabIndex={isFileError ? -1 : undefined}
                  role={isFileError ? 'group' : undefined}
                  aria-label={isFileError ? `${entry.role} download error` : undefined}
                  data-testid={`companion-model-file-${entry.id}`}
                  data-state={state}
                  borderRadius="sm"
                  border="1px solid"
                  bg={rowColors.bg}
                  borderColor={rowColors.borderColor}
                  p={2}
                  outline="none"
                  _focusVisible={{ boxShadow: '0 0 0 2px var(--accent-primary)' }}
                >
                  <HStack gap={3} align="flex-start">
                    <VStack align="stretch" gap={1} flex={1} minW="0">
                      <Text fontSize="xs" fontWeight="600" color="fg.default">
                        {entry.role}
                      </Text>
                      <Text
                        fontSize="11px"
                        fontFamily="mono"
                        color="fg.muted"
                        wordBreak="break-all"
                      >
                        {entry.filename}
                      </Text>

                      {state === 'downloading' && (
                        <Box
                          mt={1}
                          data-testid={`companion-model-file-${entry.id}-progress`}
                        >
                          <Progress.Root
                            value={expected > 0 ? displayPercent : null}
                            size="xs"
                            aria-label={`${entry.role} download progress`}
                            aria-valuetext={`${entry.role} download, ${displayPercent} percent, ${formatBytes(
                              downloaded,
                            )} of ${formatBytes(expected)}`}
                          >
                            <Progress.Track>
                              <Progress.Range />
                            </Progress.Track>
                          </Progress.Root>
                          <Text mt={1} fontSize="11px" color="fg.muted">
                            {displayPercent}% · {formatBytes(downloaded)} /{' '}
                            {formatBytes(expected)}
                          </Text>
                        </Box>
                      )}

                      {isFileError && (
                        <Text
                          mt={1}
                          fontSize="11px"
                          color="status.error"
                          wordBreak="break-all"
                        >
                          {file.detail ??
                            errorText ??
                            'Download failed — choose Retry.'}
                        </Text>
                      )}

                      {state === 'missing' && file.detail && (
                        <Text
                          mt={1}
                          fontSize="11px"
                          color="fg.muted"
                          wordBreak="break-all"
                        >
                          {file.detail}
                        </Text>
                      )}

                      {state === 'present' && file.path && (
                        <Text
                          mt={1}
                          fontSize="11px"
                          fontFamily="mono"
                          color="fg.muted"
                          wordBreak="break-all"
                        >
                          {file.path}
                        </Text>
                      )}
                    </VStack>

                    <HStack
                      gap={1}
                      align="center"
                      flexShrink={0}
                      data-testid={`companion-model-file-${entry.id}-status`}
                    >
                      {state === 'present' && (
                        <>
                          <Icon
                            as={LuCircleCheck}
                            boxSize="15px"
                            color="status.success"
                            aria-hidden
                          />
                          <Text fontSize="xs" fontWeight="600" color="status.success">
                            Present
                          </Text>
                        </>
                      )}
                      {state === 'downloading' && (
                        <>
                          <Spinner size="xs" color="accent.default" aria-hidden />
                          <Text fontSize="xs" fontWeight="600" color="accent.default">
                            Downloading
                          </Text>
                        </>
                      )}
                      {state === 'error' && (
                        <>
                          <Icon
                            as={LuCircleX}
                            boxSize="15px"
                            color="status.error"
                            aria-hidden
                          />
                          <Text fontSize="xs" fontWeight="600" color="status.error">
                            Error
                          </Text>
                        </>
                      )}
                      {state === 'missing' && (
                        <>
                          <Icon
                            as={LuCircleDashed}
                            boxSize="15px"
                            color="status.warning"
                            aria-hidden
                          />
                          <Text fontSize="xs" fontWeight="600" color="status.warning">
                            Missing
                          </Text>
                        </>
                      )}
                    </HStack>

                    {isFileError && (
                      <Button
                        size="xs"
                        variant="outline"
                        data-testid={`companion-model-file-${entry.id}-retry`}
                        color="status.error"
                        aria-label={`Retry ${entry.role} download`}
                        onClick={() => onRunAction(step.id)}
                        _hover={{ bg: 'var(--hover-bg)' }}
                        flexShrink={0}
                      >
                        <Icon as={LuRefreshCw} boxSize="13px" mr={1} aria-hidden />
                        Retry
                      </Button>
                    )}
                  </HStack>
                </Box>
              );
            })}
          </VStack>

          <HStack gap={2} wrap="wrap">
            {stepState !== 'complete' && !isChecking && step.action && (
              <Button
                size="sm"
                data-testid={`companion-step-${step.testId}-download`}
                bg="var(--accent-primary)"
                color="white"
                disabled={isDownloading}
                aria-busy={isDownloading || undefined}
                onClick={() => onRunAction(step.id)}
                _hover={{ opacity: 0.9 }}
              >
                <Icon as={LuDownload} boxSize="14px" mr={1} aria-hidden />
                {isDownloading
                  ? step.action.runningLabel
                  : step.action.label}
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

          {stepState === 'complete' && detail && (
            <Text fontSize="11px" fontFamily="mono" color="fg.muted" wordBreak="break-all">
              {detail}
            </Text>
          )}
        </VStack>
      </Box>
    </Box>
  );
};
