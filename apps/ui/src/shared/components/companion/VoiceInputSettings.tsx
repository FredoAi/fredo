/**
 * VoiceInputSettings — the Companion settings "Voice input" group (Spec #2877
 * ST-4; DR-1/2/3/5/6/10/11/12).
 *
 * This is a THIRD group inside the EXISTING Companion settings section
 * (`CompanionSettingsPanel` ready branch) — no new settings nav item and no
 * dedicated Voice section. It hosts, in order:
 *   0. C0 — the speech-handling selector (#2897 ST-1 / REQ-1): a labelled
 *      `chakra.select` over the closed `'local'` (Local transcription, DEFAULT)
 *      | `'model'` (Model audio) set, persisted through `voiceHandling` on the
 *      CompanionContext and read by the backend on every `stt_start` so a change
 *      applies to the NEXT listen with no restart. The model help states the
 *      no-transcript guarantee.
 *   1. C1 — the master opt-in enable switch (`Hold Space to dictate`,
 *      `aria-label="Enable voice input"`, DEFAULT OFF). Toggling OFF while a
 *      session is live stops it and releases the microphone (DR-2 / R-1.1).
 *      The label/help teach the SHIPPED gesture — hold Space in the launcher
 *      search bar — and never claim Ctrl+Space starts dictation (#2882 ST-7).
 *   2. R-1.3 — a compact engine-status line (idle / listening / error + detail).
 *   3. C2 — the "Voice input model" row with DR-3's six states (not-checked /
 *      not-installed / downloading / ready / error / interrupted+resume), ONE
 *      primary action + Re-check, an aggregate determinate progress bar, the
 *      resolved model location on ready AND error, and curated `role="alert"`
 *      copy (`errorCopyFor('sttModel', …)`) — never a raw IPC string as the
 *      primary sentence (R-2.1–R-2.5 / R-5.2).
 *   4. C3 — the input-device selector using `chakra.select` (NEVER
 *      `NativeSelect`), persisting `Fredo_companion_voice_device_id`, with
 *      checking / devices / no-device / vanished / permission-denied /
 *      unavailable sub-states and a Re-scan control (R-3.2 / R-5.1). A vanished
 *      selection is never silently switched to another device (AC4).
 *   5. C4 — the autosend switch (`Send transcripts automatically`, DEFAULT OFF)
 *      whose behaviour captions flip with the control. The SETTING lives here;
 *      its dispatch is #2878 (R-1.2 / DR-6).
 *   6. DR-10 — ONE persistent polite live region for settings state changes.
 *
 * The group is informational with respect to companion chat: it NEVER feeds
 * `CompanionReadiness.ready` — installing, enabling or removing voice input can
 * never block or unblock companion chat.
 *
 * Token-first: every color is a semantic token / CSS var, every alpha goes
 * through the shared `tint()` helper (never a `var(--x)NN` alpha-append), and
 * every geometric size is a CSS unit string (never a bare numeric size prop).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  chakra,
  HStack,
  Icon,
  Progress,
  Switch,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuCircleCheck,
  LuCircleDashed,
  LuCircleX,
  LuDownload,
  LuRefreshCw,
  LuTriangleAlert,
} from 'react-icons/lu';

import { useCompanion } from '../../contexts/CompanionContext';
import type { VoiceHandling } from '../../contexts/CompanionContext';
import { DEFAULT_VOICE_HANDLING } from '../../contexts/CompanionContext';
import { useVoiceDictation } from '../../hooks/useVoiceDictation';
import type { VoiceErrorCode } from '../../hooks/useVoiceDictation';
import { tint } from '../../utils/colorTint';
import { errorCopyFor, normalizeDeviceId } from './companionReadiness';
import type {
  ModelFileStatus,
  SttDeviceProbe,
  SttModelReadiness,
} from './companionReadiness';

// ── Frozen accessibility ids ─────────────────────────────────────────────────

const VOICE_ENABLE_HELP_ID = 'companion-voice-enable-help';
const VOICE_HANDLING_HELP_ID = 'companion-voice-handling-help';
const VOICE_DEVICE_HELP_ID = 'companion-voice-device-help';
const VOICE_AUTOSEND_HELP_ID = 'companion-voice-autosend-help';

/** The shipped on-device engine behind voice input (names the engine in R-1.3). */
export const VOICE_ENGINE_NAME = 'Streaming Zipformer (English, on-device)';

/** Human name for the system-default device option. */
export const SYSTEM_DEFAULT_DEVICE_LABEL = 'System default';

/**
 * Help copy under the master enable label (#2882 ST-7 / R-7). It teaches the
 * SHIPPED gesture only: hold Space in the launcher search bar, release for
 * editable text, Enter to send (or autosend on release), a transcript that is
 * always Fredo's, and Ctrl+Space as the bar-opening chord — never dictation.
 */
const VOICE_ENABLE_HELP_COPY =
  'In the launcher search bar, hold Space to dictate; release and the words land in the bar as ' +
  'editable text. Enter then sends them to Fredo — with “Send voice transcripts automatically” ' +
  'on, they’re sent the moment you release. A dictated transcript always goes to Fredo and never ' +
  'opens an app, even after you edit it. Ctrl+Space only brings the search bar forward; it never ' +
  'starts dictation. Transcription runs locally — nothing leaves this machine.';

// ── Model row state (DR-3) ───────────────────────────────────────────────────

/** The six presentation states of the "Voice input model" row (DR-3). */
export type SttModelUiState =
  | 'not-checked'
  | 'not-installed'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'interrupted';

/** Stable `data-state` vocabulary (DR-3): interrupted shares `missing`. */
export type SttModelRowDataState =
  | 'not-checked'
  | 'missing'
  | 'downloading'
  | 'installed'
  | 'error';

/**
 * Derive the model-row presentation state. An in-flight transfer wins (the row
 * must stay honest while bytes move); an explicit action error or any per-file
 * `error` is next; a completed set is `ready`; a `missing` file with bytes on
 * disk is `interrupted` (resumable); otherwise `not-installed`.
 */
export function deriveSttModelUiState(input: {
  model: SttModelReadiness | null;
  downloading: boolean;
  error: string | null;
}): SttModelUiState {
  const model = input.model;
  if (!model) return 'not-checked';
  const files = model.files;
  if (input.downloading || files.some((file) => file.state === 'downloading')) {
    return 'downloading';
  }
  const hasActionError = typeof input.error === 'string' && input.error.length > 0;
  if (hasActionError || files.some((file) => file.state === 'error')) return 'error';
  if (model.ready) return 'ready';
  if (files.some((file) => file.state === 'missing' && file.downloadedBytes > 0)) {
    return 'interrupted';
  }
  return 'not-installed';
}

/** Map the presentation state to the frozen `data-state` vocabulary (DR-3). */
export function sttModelRowDataState(state: SttModelUiState): SttModelRowDataState {
  switch (state) {
    case 'not-checked':
      return 'not-checked';
    case 'downloading':
      return 'downloading';
    case 'ready':
      return 'installed';
    case 'error':
      return 'error';
    default:
      return 'missing';
  }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/** Byte formatter (mirrors the wizard card's presentation). */
export function formatBytes(bytes: number): string {
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

interface AggregateBytes {
  downloaded: number;
  expected: number;
}

/** Aggregate downloaded/expected bytes across the pinned STT files. */
export function aggregateBytes(files: readonly ModelFileStatus[]): AggregateBytes {
  return files.reduce<AggregateBytes>(
    (acc, file) => ({
      downloaded:
        acc.downloaded +
        (Number.isFinite(file.downloadedBytes) ? Math.max(0, file.downloadedBytes) : 0),
      expected:
        acc.expected +
        (Number.isFinite(file.expectedBytes) ? Math.max(0, file.expectedBytes) : 0),
    }),
    { downloaded: 0, expected: 0 },
  );
}

/** The first per-file raw error detail, used only as demoted technical copy. */
function firstErrorDetail(files: readonly ModelFileStatus[]): string | null {
  const errored = files.find((file) => file.state === 'error');
  return errored?.detail ?? null;
}

// ── Curated voice engine-error copy (DR-11) ──────────────────────────────────

/**
 * Curated, actionable copy for the active engine error (R-1.3 / DR-11). The raw
 * backend detail is never the primary sentence — it is surfaced separately as a
 * labelled mono line.
 */
export function voiceErrorCopyFor(code: VoiceErrorCode | null): string {
  switch (code) {
    case 'permissionDenied':
      return 'Microphone access is blocked — allow it in Windows Settings → Privacy → Microphone, then try again.';
    case 'noDevice':
      return 'No microphone is available. Connect a microphone, then choose Re-scan.';
    case 'modelMissing':
      return "The voice input model isn't installed. Choose Download voice model above, then try again.";
    case 'modelCorrupt':
      return 'The voice input model files are damaged. Choose Re-download voice model above to repair them.';
    case 'engineStartFailed':
      return "The voice engine didn't start. Try again; if it persists, re-check the model files.";
    case 'disabled':
      return 'Voice input is off. Turn on “Hold Space to dictate” above, then hold Space in the launcher search bar.';
    case 'alreadyListening':
      return 'A dictation session is already listening.';
    case 'internal':
      return 'Voice input hit an unexpected problem. Try again.';
    default:
      return 'Voice input hit an unexpected problem. Try again.';
  }
}

// ── Device selector state (DR-5) ─────────────────────────────────────────────

type DeviceRowState =
  | 'checking'
  | 'devices'
  | 'no-device'
  | 'vanished'
  | 'permission-denied'
  | 'unavailable';

interface DeviceRowView {
  state: DeviceRowState;
  /** Help/caption copy bound to `aria-describedby`. */
  help: string;
  /** Whether the caption is actionable (warning/error treatment). */
  warning: boolean;
}

/** Resolve the device row's presentation sub-state + help copy (DR-5). */
export function deriveDeviceRowView(input: {
  probe: SttDeviceProbe;
  selectedId: string | null;
  deviceCount: number;
}): DeviceRowView {
  const { probe, selectedId, deviceCount } = input;
  if (probe.state === 'checking') {
    return {
      state: 'checking',
      help: 'Checking your microphones…',
      warning: false,
    };
  }
  const persistedMissing =
    selectedId !== null &&
    deviceCount > 0 &&
    !probe.devices.some((device) => device.id === selectedId);
  if (probe.state === 'vanished' || persistedMissing) {
    return {
      state: 'vanished',
      help: "The previously selected microphone isn't available — pick a microphone or use the system default. Fredo never switches devices on its own.",
      warning: true,
    };
  }
  if (probe.state === 'permissionDenied') {
    return {
      state: 'permission-denied',
      help: 'Microphone access is blocked — allow it in Windows Settings → Privacy → Microphone, then choose Re-scan.',
      warning: true,
    };
  }
  if (probe.state === 'no-device') {
    return {
      state: 'no-device',
      help: 'No microphone found. Connect a microphone, then choose Re-scan.',
      warning: true,
    };
  }
  if (probe.state === 'unavailable') {
    return {
      state: 'unavailable',
      help: "Couldn't check your microphones — the Fredo backend is unavailable. Choose Re-scan to try again.",
      warning: true,
    };
  }
  return {
    state: 'devices',
    help: 'Choose which microphone Fredo listens to.',
    warning: false,
  };
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface VoiceInputSettingsProps {
  /** Derived STT model readiness ({null} = the probe is unavailable). */
  sttModel: SttModelReadiness | null;
  /** Derived input-device probe (fail-closed when the backend is absent). */
  sttDevices: SttDeviceProbe;
  /** A `download_stt_model` run is in flight. */
  sttDownloading: boolean;
  /** Curated primary error from the last failed download (or null). */
  sttError: string | null;
  /** Start/continue the model acquisition (the single primary action). */
  onDownloadModel: () => void;
  /** Re-probe the model + readiness (Re-check). */
  onRecheck: () => void;
  /** Re-scan the input devices (Re-scan). */
  onRescanDevices: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

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

export const VoiceInputSettings: React.FC<VoiceInputSettingsProps> = ({
  sttModel,
  sttDevices,
  sttDownloading,
  sttError,
  onDownloadModel,
  onRecheck,
  onRescanDevices,
}) => {
  const {
    voiceEnabled, setVoiceEnabled,
    voiceAutosend, setVoiceAutosend,
    voiceDeviceId, setVoiceDeviceId,
    voiceHandling, setVoiceHandling,
  } = useCompanion();

  // The app-global session state (R-1.3). Control-plane events only.
  const { listening, errorCode, detail, deviceName, stop } = useVoiceDictation();

  // ── DR-10 — one persistent polite live region for settings changes ──────────
  const [announcement, setAnnouncement] = useState('');

  // ── C2 — the model row state ───────────────────────────────────────────────
  const modelState = useMemo(
    () =>
      deriveSttModelUiState({
        model: sttModel,
        downloading: sttDownloading,
        error: sttError,
      }),
    [sttModel, sttDownloading, sttError],
  );
  const rowDataState = sttModelRowDataState(modelState);

  const sttFiles = sttModel?.files ?? [];
  const presentCount = sttFiles.filter((file) => file.state === 'present').length;
  const totalCount = sttFiles.length;
  const totals = useMemo(() => aggregateBytes(sttFiles), [sttFiles]);
  const progressPercent =
    totals.expected > 0
      ? Math.round(clampPercent((totals.downloaded / totals.expected) * 100))
      : 0;
  const errorCopy = useMemo(() => {
    const rawDetail = firstErrorDetail(sttFiles);
    return errorCopyFor('sttModel', null, rawDetail);
  }, [sttFiles]);

  // Announce model state TRANSITIONS (never per event) through the live region.
  const prevModelStateRef = useRef<SttModelUiState | null>(null);
  useEffect(() => {
    const prev = prevModelStateRef.current;
    prevModelStateRef.current = modelState;
    if (prev === null || prev === modelState) return;
    if (modelState === 'downloading') setAnnouncement('Downloading the voice input model.');
    else if (modelState === 'ready') setAnnouncement('Voice input model installed.');
    else if (modelState === 'error') setAnnouncement('Voice input model download failed.');
  }, [modelState]);

  const handleEnableChange = useCallback(
    (enabled: boolean) => {
      setVoiceEnabled(enabled);
      setAnnouncement(enabled ? 'Voice input is on.' : 'Voice input is off.');
      // DR-2 / R-1.1 / R-4.2 — disabling while listening stops + releases the mic.
      if (!enabled && listening) void stop();
    },
    [setVoiceEnabled, listening, stop],
  );

  // ── C0 — speech handling (#2897 ST-1 / REQ-1) ──────────────────────────────
  // The closed set is `'local' | 'model'`; anything else heals to the default
  // (the same rule the context applies on load). Changing the value persists
  // immediately and applies to the NEXT listen — never an in-flight session.
  const handleHandlingChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next: VoiceHandling =
        event.target.value === 'model' ? 'model' : DEFAULT_VOICE_HANDLING;
      setVoiceHandling(next);
      setAnnouncement(
        next === 'model'
          ? 'Speech handling set to Model audio — no words will be shown.'
          : 'Speech handling set to Local transcription.',
      );
    },
    [setVoiceHandling],
  );

  // ── C3 — the device selector ───────────────────────────────────────────────
  const selectedId = normalizeDeviceId(voiceDeviceId);
  const devices = sttDevices.devices;
  const deviceView = deriveDeviceRowView({
    probe: sttDevices,
    selectedId,
    deviceCount: devices.length,
  });
  const deviceSelectDisabled =
    deviceView.state === 'checking' ||
    deviceView.state === 'no-device' ||
    deviceView.state === 'unavailable';
  const deviceVanishedOption =
    deviceView.state === 'vanished' && selectedId !== null ? selectedId : null;

  const handleDeviceChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      setVoiceDeviceId(next);
      setAnnouncement(
        next ? `Input device set to ${next}.` : 'Input device set to system default.',
      );
    },
    [setVoiceDeviceId],
  );

  const handleRescanDevices = useCallback(() => {
    setAnnouncement('Re-scanning for microphones.');
    onRescanDevices();
  }, [onRescanDevices]);

  // ── C4 — autosend ──────────────────────────────────────────────────────────
  const handleAutosendChange = useCallback(
    (enabled: boolean) => {
      setVoiceAutosend(enabled);
      setAnnouncement(
        enabled
          ? 'Transcripts will be sent automatically.'
          : 'Transcripts will wait for review.',
      );
    },
    [setVoiceAutosend],
  );

  // ── R-1.3 — engine status ──────────────────────────────────────────────────
  const engineState: 'idle' | 'listening' | 'error' = listening
    ? 'listening'
    : errorCode
      ? 'error'
      : 'idle';
  const engineCopy =
    engineState === 'listening'
      ? `${VOICE_ENGINE_NAME} is listening${deviceName ? ` on ${deviceName}` : ''}.`
      : engineState === 'error'
        ? `${VOICE_ENGINE_NAME} — ${voiceErrorCopyFor(errorCode)}`
        : `${VOICE_ENGINE_NAME} is idle — not listening.`;
  const engineColor =
    engineState === 'listening'
      ? 'var(--accent-primary)'
      : engineState === 'error'
        ? 'var(--status-error)'
        : 'var(--text-subtle)';

  // ── C2 — per-state caption + action ────────────────────────────────────────
  const modelCaption = (() => {
    switch (modelState) {
      case 'not-checked':
        return 'Not checked — the Fredo backend is unavailable.';
      case 'downloading':
        return 'Downloading voice input model…';
      case 'ready':
        return 'Voice input model installed.';
      case 'error':
        return sttError ?? errorCopy.message;
      case 'interrupted':
        return `Interrupted — ${formatBytes(totals.downloaded)} of ${formatBytes(
          totals.expected,
        )}. Choose Download to resume.`;
      default:
        return `Voice input model not installed — ${presentCount} of ${totalCount} files. Choose Download voice model.`;
    }
  })();

  const modelCaptionColor = (() => {
    switch (modelState) {
      case 'ready':
        return 'var(--status-success)';
      case 'interrupted':
        return 'var(--status-warning)';
      case 'error':
        return 'var(--status-error)';
      case 'downloading':
        return 'var(--text-primary)';
      default:
        return 'var(--text-subtle)';
    }
  })();

  const modelActionLabel = (() => {
    switch (modelState) {
      case 'downloading':
        return 'Downloading…';
      case 'ready':
        return 'Installed';
      case 'error':
        return 'Re-download voice model';
      case 'interrupted':
        return 'Resume download';
      default:
        return 'Download voice model';
    }
  })();

  const modelActionAriaLabel = (() => {
    switch (modelState) {
      case 'downloading':
        return 'Downloading voice input model';
      case 'ready':
        return 'Voice input model installed';
      case 'error':
        return 'Re-download voice input model';
      default:
        return 'Download voice input model';
    }
  })();

  const modelActionDisabled =
    modelState === 'downloading' || modelState === 'not-checked' || modelState === 'ready';

  const modelRowTint = (() => {
    switch (modelState) {
      case 'downloading':
        return {
          bg: tint('var(--accent-primary)', 8),
          borderColor: tint('var(--accent-primary)', 30),
        };
      case 'ready':
        return {
          bg: tint('var(--status-success)', 10),
          borderColor: tint('var(--status-success)', 30),
        };
      case 'error':
        return {
          bg: tint('var(--status-error)', 12),
          borderColor: tint('var(--status-error)', 30),
        };
      case 'interrupted':
        return {
          bg: tint('var(--status-warning)', 10),
          borderColor: tint('var(--status-warning)', 30),
        };
      default:
        return { bg: 'var(--hover-bg)', borderColor: 'var(--border-color)' };
    }
  })();

  const modelIcon = (() => {
    switch (modelState) {
      case 'downloading':
        return LuDownload;
      case 'ready':
        return LuCircleCheck;
      case 'error':
        return LuCircleX;
      case 'interrupted':
        return LuTriangleAlert;
      default:
        return LuCircleDashed;
    }
  })();

  const modelIconColor = (() => {
    switch (modelState) {
      case 'downloading':
        return 'accent.default';
      case 'ready':
        return 'status.success';
      case 'error':
        return 'status.error';
      case 'interrupted':
        return 'status.warning';
      default:
        return 'status.warning';
    }
  })();

  return (
    <Box>
      {sectionLabel('Voice input')}
      <VStack align="stretch" gap={2}>
        {/* ── C0 — speech handling (#2897 ST-1 / REQ-1) ──────────────────── */}
        <Box
          data-testid="companion-voice-handling-row"
          p={3}
          borderRadius="md"
          background="var(--hover-bg)"
          border="1px solid var(--border-color)"
        >
          <VStack align="stretch" gap={2}>
            <HStack justify="space-between" align="center" gap={2}>
              <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                Speech handling
              </Text>
              <chakra.select
                value={voiceHandling}
                onChange={handleHandlingChange}
                aria-label="Speech handling"
                aria-describedby={VOICE_HANDLING_HELP_ID}
                data-testid="companion-voice-handling-select"
                maxWidth="260px"
                height="32px"
                border="1px solid"
                borderRadius="md"
                px={2}
                fontSize="sm"
                bg="var(--card-bg)"
                borderColor="var(--border-color)"
                color="var(--text-primary)"
                cursor="pointer"
                _hover={{ borderColor: 'var(--accent-primary)' }}
                _focus={{
                  outline: 'none',
                  borderColor: 'var(--accent-primary)',
                  boxShadow: '0 0 0 1px var(--accent-primary)',
                }}
              >
                <option value="local">Local transcription</option>
                <option value="model">Model audio</option>
              </chakra.select>
            </HStack>

            <Text
              id={VOICE_HANDLING_HELP_ID}
              data-testid="companion-voice-handling-help"
              fontSize="xs"
              color="var(--text-subtle)"
            >
              {voiceHandling === 'model'
                ? 'Fredo hands your recording to the locally-running companion model as your message — no words are shown. Nothing leaves this machine.'
                : 'Words appear in the launcher bar as you speak, transcribed on this machine. Nothing leaves this machine.'}
            </Text>
          </VStack>
        </Box>

        {/* ── C1 — master enable (DR-2) ───────────────────────────────────── */}
        <HStack
          justify="space-between"
          p={3}
          borderRadius="md"
          background="var(--hover-bg)"
          border="1px solid var(--border-color)"
        >
          <VStack align="start" gap={0}>
            <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
              Hold Space to dictate
            </Text>
            <Text
              id={VOICE_ENABLE_HELP_ID}
              fontSize="xs"
              color="var(--text-subtle)"
            >
              {VOICE_ENABLE_HELP_COPY}
            </Text>
          </VStack>
          <Switch.Root
            checked={voiceEnabled}
            onCheckedChange={(e) => handleEnableChange(e.checked)}
            colorPalette="accent"
            size="md"
          >
            <Switch.HiddenInput
              aria-label="Enable voice input"
              aria-describedby={VOICE_ENABLE_HELP_ID}
            />
            <Switch.Control
              bg="var(--text-primary)"
              _checked={{ bg: 'var(--accent-primary)' }}
              _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '2px' }}
            >
              <Switch.Thumb bg="var(--card-bg)" _checked={{ bg: 'var(--accent-contrast)' }} />
            </Switch.Control>
          </Switch.Root>
        </HStack>

        {/* ── R-1.3 — current engine state ────────────────────────────────── */}
        <Text
          data-testid="companion-voice-engine-status"
          data-state={engineState}
          fontSize="xs"
          color={engineColor}
        >
          {engineCopy}
        </Text>
        {engineState === 'error' && detail && (
          <Text fontSize="11px" fontFamily="mono" color="var(--text-subtle)" wordBreak="break-all">
            Technical details: {detail}
          </Text>
        )}

        {/* ── C2 — "Voice input model" row (DR-3) ─────────────────────────── */}
        <Box
          data-testid="companion-voice-model-row"
          data-state={rowDataState}
          p={3}
          borderRadius="md"
          bg={modelRowTint.bg}
          border="1px solid"
          borderColor={modelRowTint.borderColor}
        >
          <VStack align="stretch" gap={2}>
            <HStack justify="space-between" align="flex-start" gap={2}>
              <VStack align="start" gap={0} minW="0" flex={1}>
                <HStack gap={1} align="center">
                  <Icon as={modelIcon} boxSize="14px" color={modelIconColor} aria-hidden />
                  <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                    Voice input model
                  </Text>
                </HStack>
                <Text
                  data-testid="companion-voice-model-status"
                  data-state={rowDataState}
                  role={modelState === 'error' ? 'alert' : undefined}
                  fontSize="xs"
                  color={modelCaptionColor}
                >
                  {modelCaption}
                </Text>
              </VStack>

              <HStack gap={1} align="center" flexShrink={0}>
                <Button
                  size="sm"
                  data-testid="companion-voice-model-download"
                  aria-label={modelActionAriaLabel}
                  bg="var(--accent-primary)"
                  color="var(--accent-contrast)"
                  disabled={modelActionDisabled}
                  aria-busy={modelState === 'downloading' || undefined}
                  onClick={onDownloadModel}
                  _hover={{ opacity: 0.9 }}
                >
                  <Icon as={LuDownload} boxSize="14px" mr={1} aria-hidden />
                  {modelActionLabel}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="companion-voice-model-recheck"
                  aria-label="Re-check voice input model"
                  color="var(--text-primary)"
                  onClick={onRecheck}
                  _hover={{ bg: 'var(--hover-bg)' }}
                >
                  <Icon as={LuRefreshCw} boxSize="14px" mr={1} aria-hidden />
                  Re-check
                </Button>
              </HStack>
            </HStack>

            {/* Aggregate determinate progress while the model is downloading. */}
            {modelState === 'downloading' && (
              <Box data-testid="companion-voice-model-progress">
                <Progress.Root
                  value={totals.expected > 0 ? progressPercent : null}
                  size="xs"
                >
                  {/* Chakra v3 puts `role="progressbar"` on the TRACK — carry the
                      accessible name + value text on that same element. */}
                  <Progress.Track
                    role="progressbar"
                    aria-label="Voice input model download progress"
                    aria-valuetext={`Voice input model download, ${progressPercent} percent, ${formatBytes(
                      totals.downloaded,
                    )} of ${formatBytes(totals.expected)}`}
                  >
                    <Progress.Range />
                  </Progress.Track>
                </Progress.Root>
                <Text mt={1} fontSize="11px" color="var(--text-primary)">
                  {progressPercent}% · {formatBytes(totals.downloaded)} /{' '}
                  {formatBytes(totals.expected)}
                </Text>
              </Box>
            )}

            {/* The raw backend detail is demoted to a labelled mono line — the
                curated sentence above is the primary message (DR-11). */}
            {modelState === 'error' && errorCopy.technicalDetail && (
              <Text
                fontSize="11px"
                fontFamily="mono"
                color="var(--text-subtle)"
                wordBreak="break-all"
              >
                Technical details: {errorCopy.technicalDetail}
              </Text>
            )}

            {/* Resolved on-disk model location — ready AND error (AC2 / R-2.4). */}
            {(modelState === 'ready' || modelState === 'error') && sttModel?.location && (
              <Text
                data-testid="companion-voice-model-location"
                fontSize="11px"
                fontFamily="mono"
                color="var(--text-subtle)"
                wordBreak="break-all"
              >
                {sttModel.location}
              </Text>
            )}
          </VStack>
        </Box>

        {/* ── C3 — input device selection (DR-5) ──────────────────────────── */}
        <Box
          data-testid="companion-voice-device-row"
          data-state={deviceView.state}
          p={3}
          borderRadius="md"
          background="var(--hover-bg)"
          border="1px solid var(--border-color)"
        >
          <VStack align="stretch" gap={2}>
            <HStack justify="space-between" align="center" gap={2}>
              <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                Input device
              </Text>
              <chakra.select
                value={selectedId ?? ''}
                onChange={handleDeviceChange}
                disabled={deviceSelectDisabled}
                aria-label="Input device for voice dictation"
                aria-describedby={VOICE_DEVICE_HELP_ID}
                data-testid="companion-voice-device-select"
                maxWidth="260px"
                height="32px"
                border="1px solid"
                borderRadius="md"
                px={2}
                fontSize="sm"
                bg="var(--card-bg)"
                borderColor="var(--border-color)"
                color="var(--text-primary)"
                cursor="pointer"
                _hover={{ borderColor: 'var(--accent-primary)' }}
                _focus={{
                  outline: 'none',
                  borderColor: 'var(--accent-primary)',
                  boxShadow: '0 0 0 1px var(--accent-primary)',
                }}
                _disabled={{ opacity: 0.6 }}
              >
                <option value="">{SYSTEM_DEFAULT_DEVICE_LABEL}</option>
                {deviceVanishedOption && (
                  <option value={deviceVanishedOption} disabled>
                    {deviceVanishedOption} — not available
                  </option>
                )}
                {devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
                {deviceView.state === 'checking' && (
                  <option value="">Checking microphones…</option>
                )}
              </chakra.select>
            </HStack>

            <Text
              id={VOICE_DEVICE_HELP_ID}
              fontSize="xs"
              color={deviceView.warning ? 'var(--status-warning)' : 'var(--text-subtle)'}
            >
              {deviceView.help}
            </Text>

            {deviceView.state !== 'devices' && (
              <HStack>
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="companion-voice-device-rescan"
                  aria-label="Re-scan for microphones"
                  color="var(--text-primary)"
                  disabled={deviceView.state === 'checking'}
                  onClick={handleRescanDevices}
                  _hover={{ bg: 'var(--hover-bg)' }}
                >
                  <Icon as={LuRefreshCw} boxSize="13px" mr={1} aria-hidden />
                  Re-scan
                </Button>
              </HStack>
            )}
          </VStack>
        </Box>

        {/* ── C4 — autosend (DR-6; the setting only — dispatch is #2878) ──── */}
        <HStack
          justify="space-between"
          p={3}
          borderRadius="md"
          background="var(--hover-bg)"
          border="1px solid var(--border-color)"
        >
          <VStack align="start" gap={0}>
            <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
              Send transcripts automatically
            </Text>
            <Text id={VOICE_AUTOSEND_HELP_ID} fontSize="xs" color="var(--text-subtle)">
              {voiceAutosend
                ? 'Transcripts are sent as soon as you stop — no review.'
                : 'Transcripts appear in the launcher bar for review before you send.'}
            </Text>
          </VStack>
          <Switch.Root
            checked={voiceAutosend}
            onCheckedChange={(e) => handleAutosendChange(e.checked)}
            colorPalette="accent"
            size="md"
          >
            <Switch.HiddenInput
              aria-label="Send voice transcripts automatically"
              aria-describedby={VOICE_AUTOSEND_HELP_ID}
              data-testid="companion-voice-autosend"
            />
            <Switch.Control
              bg="var(--text-primary)"
              _checked={{ bg: 'var(--accent-primary)' }}
              _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '2px' }}
            >
              <Switch.Thumb bg="var(--card-bg)" _checked={{ bg: 'var(--accent-contrast)' }} />
            </Switch.Control>
          </Switch.Root>
        </HStack>

        {/* ── DR-10 — ONE persistent polite live region for settings changes ─ */}
        <Box
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="companion-voice-settings-announcer"
          position="absolute"
          width="1px"
          height="1px"
          padding="0"
          margin="-1px"
          overflow="hidden"
          clipPath="inset(50%)"
          whiteSpace="nowrap"
          borderWidth="0"
        >
          {announcement}
        </Box>
      </VStack>
    </Box>
  );
};

export default VoiceInputSettings;
