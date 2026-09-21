/**
 * VoiceInputSettings — the Companion settings "Voice input" group (Spec #2877
 * ST-4; DR-1/2/3/5/6/10/11/12).
 *
 * This is a THIRD group inside the EXISTING Companion settings section
 * (`CompanionSettingsPanel` ready branch) — no new settings nav item and no
 * dedicated Voice section. Spec #2914 ST-3 reduced it to the SINGLE model-audio
 * mode: the speech-handling selector, the STT ("Voice input model") download
 * row, the sherpa engine-status line and the autosend switch are gone, so no
 * affordance selects, installs or repairs a local on-device engine. The group
 * hosts, in order:
 *   1. C1 — the master opt-in enable switch (`Hold Space to dictate`,
 *      `aria-label="Enable voice input"`, DEFAULT OFF). Toggling OFF while a
 *      session is live stops it and releases the microphone (DR-2 / R-1.1).
 *      The label/help teach the SHIPPED gesture — hold Space in the launcher
 *      search bar (#2882 ST-7).
 *   2. R-4 — the model-audio capability row (unconditional). The backend owns
 *      the `stt_audio_capability` verdict; the row derives its sentence/actions
 *      from it and NEVER infers capability from a model name. There is exactly
 *      ONE voice path, so the row cannot be gated behind a mode selector.
 *   3. C3 — the input-device selector using `chakra.select` (NEVER
 *      `NativeSelect`), persisting `Fredo_companion_voice_device_id`, with
 *      checking / devices / no-device / vanished / permission-denied /
 *      unavailable sub-states and a Re-scan control (R-3.2 / R-5.1). A vanished
 *      selection is never silently switched to another device (AC4).
 *   4. DR-10 — ONE persistent polite live region for settings state changes.
 *
 * The group is informational with respect to companion chat: it NEVER feeds
 * `CompanionReadiness.ready` — installing, enabling or removing voice input can
 * never block or unblock companion chat.
 *
 * Token-first: every color is a semantic token / CSS var, every alpha goes
 * through the shared `tint()` helper (never a `var(--x)NN` alpha-append), and
 * every geometric size is a CSS unit string (never a bare numeric size prop).
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  chakra,
  HStack,
  Icon,
  Switch,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuCircleCheck,
  LuCircleDashed,
  LuCircleX,
  LuRefreshCw,
  LuTriangleAlert,
} from 'react-icons/lu';

import { useCompanion } from '../../contexts/CompanionContext';
import { useModelAudioCapability } from '../../hooks/useModelAudioCapability';
import { useVoiceDictation } from '../../hooks/useVoiceDictation';
import type { VoiceErrorCode } from '../../hooks/useVoiceDictation';
import { tint } from '../../utils/colorTint';
import {
  deriveModelAudioReadinessRow,
  MODEL_AUDIO_FAILURE_COPY,
  normalizeDeviceId,
} from './companionReadiness';
import type {
  ModelAudioReadinessRow,
  SttAudioCapability,
  SttDeviceProbe,
} from './companionReadiness';

// ── Frozen accessibility ids ─────────────────────────────────────────────────

const VOICE_ENABLE_HELP_ID = 'companion-voice-enable-help';
const VOICE_DEVICE_HELP_ID = 'companion-voice-device-help';

/** Human name for the system-default device option. */
export const SYSTEM_DEFAULT_DEVICE_LABEL = 'System default';

/**
 * Help copy under the master enable label (#2882 ST-7 / R-7; re-pointed in
 * Spec #2914 ST-8). It teaches the SHIPPED gesture only: hold Space in an empty
 * launcher search bar, release and the recording is handed to the locally-managed
 * companion model — there is exactly ONE speech path (model audio), no transcript
 * is shown, and Ctrl+Space only brings the bar forward. The prior copy described
 * dictation landing as editable text, an autosend toggle and a transcript that
 * "always goes to Fredo" — all removed with the local mode (R-1/R-4).
 */
const VOICE_ENABLE_HELP_COPY =
  'In the launcher search bar, hold Space to dictate (the bar must be empty); release and the ' +
  'recording is handed to Fredo’s locally-managed model — no transcript is shown, and Fredo’s ' +
  'reply appears in the normal conversation surface. Ctrl+Space only brings the search bar ' +
  'forward; it never starts dictation. Speech is captured and understood on this machine — ' +
  'nothing leaves it.';

// ── Curated voice engine-error copy (DR-11) ──────────────────────────────────

/**
 * Curated, actionable copy for the active voice error (R-1.3 / DR-11). The raw
 * backend detail is never the primary sentence. Spec #2914 ST-3 (R-3): the
 * model-audio cases are re-pointed through the (now local-free)
 * `MODEL_AUDIO_FAILURE_COPY`; the legacy local-engine cases are retained
 * byte-identical for the still-typed wire codes.
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
    // #2897 ST-6 (REQ-7) — the model-audio degradation copy: the SAME curated
    // sentences the launcher fallback alert reads (ONE copy source).
    case 'modelAudioUnsupported':
      return MODEL_AUDIO_FAILURE_COPY.modelAudioUnsupported;
    case 'modelAudioUnavailable':
      return MODEL_AUDIO_FAILURE_COPY.modelAudioUnavailable;
    case 'internal':
      return 'Voice input hit an unexpected problem. Try again.';
    default:
      return 'Voice input hit an unexpected problem. Try again.';
  }
}

// ── R-4 — Model audio status (#2897 ST-6 / REQ-7) ────────────────────────────

/** The row's action labels (frozen so tests and copy stay in lock-step). */
export const MODEL_AUDIO_CHANGE_MODEL_LABEL = 'Change model';
export const MODEL_AUDIO_RETRY_LABEL = 'Try again';

/** The actionable guidance the unsupported state's `Change model` announces. */
export const MODEL_AUDIO_CHANGE_MODEL_ANNOUNCEMENT =
  'Install a companion model with audio support from Companion setup.';

/**
 * The row's `data-state` brush. The row's anatomy mirrors the shipped device row
 * (`var(--hover-bg)` / `var(--border-color)`), with success/warning/error token
 * tints for the resolved states.
 */
export function modelAudioRowTint(state: ModelAudioReadinessRow['state']): {
  bg: string;
  borderColor: string;
} {
  switch (state) {
    case 'ready':
      return {
        bg: tint('var(--status-success)', 10),
        borderColor: tint('var(--status-success)', 30),
      };
    case 'unsupported':
    case 'server-unavailable':
      return {
        bg: tint('var(--status-warning)', 10),
        borderColor: tint('var(--status-warning)', 30),
      };
    case 'unknown':
      return {
        bg: tint('var(--status-error)', 12),
        borderColor: tint('var(--status-error)', 30),
      };
    default:
      return { bg: 'var(--hover-bg)', borderColor: 'var(--border-color)' };
  }
}

/**
 * The demoted technical qualifier for the row: the backend's `detail`, shown
 * only for the non-ready states (a raw string is NEVER the primary sentence).
 * Pure.
 */
export function modelAudioProbeDetail(
  capability: SttAudioCapability | null,
  state: ModelAudioReadinessRow['state'],
): string | null {
  const detail = capability?.detail;
  if (typeof detail !== 'string' || detail.trim().length === 0) return null;
  return state === 'unsupported' || state === 'server-unavailable' || state === 'unknown'
    ? detail.trim()
    : null;
}

/** The row's caption colour per state (text carries the state; never colour alone). */
export function modelAudioRowColor(state: ModelAudioReadinessRow['state']): string {
  switch (state) {
    case 'ready':
      return 'var(--status-success)';
    case 'unsupported':
    case 'server-unavailable':
      return 'var(--status-warning)';
    case 'unknown':
      return 'var(--status-error)';
    default:
      return 'var(--text-subtle)';
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
  /** Derived input-device probe (fail-closed when the backend is absent). */
  sttDevices: SttDeviceProbe;
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
  sttDevices,
  onRescanDevices,
}) => {
  const {
    voiceEnabled, setVoiceEnabled,
    voiceDeviceId, setVoiceDeviceId,
  } = useCompanion();

  // The app-global session state. Control-plane events only.
  const { listening, stop } = useVoiceDictation();

  // ── R-4 — Model audio status (#2897 ST-6 / REQ-7) ──────────────────────────
  // There is exactly ONE voice path, so the row is UNCONDITIONAL; the backend
  // capability probe is scoped to the feature being enabled (no probe/no chip
  // churn while voice is off). The row consumes the typed verdict and never
  // infers capability from a model name.
  const {
    capability: modelAudioCapability,
    checking: modelAudioChecking,
    refresh: refreshModelAudioCapability,
  } = useModelAudioCapability(voiceEnabled);
  const modelAudioRow = useMemo(
    () => deriveModelAudioReadinessRow(modelAudioCapability, modelAudioChecking),
    [modelAudioCapability, modelAudioChecking],
  );

  // ── DR-10 — one persistent polite live region for settings changes ──────────
  const [announcement, setAnnouncement] = useState('');

  const handleEnableChange = useCallback(
    (enabled: boolean) => {
      setVoiceEnabled(enabled);
      setAnnouncement(enabled ? 'Voice input is on.' : 'Voice input is off.');
      // DR-2 / R-1.1 / R-4.2 — disabling while listening stops + releases the mic.
      if (!enabled && listening) void stop();
    },
    [setVoiceEnabled, listening, stop],
  );

  // ── R-4 — Model audio status actions (#2897 ST-6 / REQ-7) ──────────────────
  // `Change model` names the actionable path (the companion model is installed
  // from Companion setup); it never fabricates a selection.
  const handleChangeModel = useCallback(() => {
    setAnnouncement(MODEL_AUDIO_CHANGE_MODEL_ANNOUNCEMENT);
  }, []);

  const handleRetryModelAudio = useCallback(() => {
    setAnnouncement("Checking the companion model's audio support again.");
    refreshModelAudioCapability();
  }, [refreshModelAudioCapability]);

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

  return (
    <Box>
      {sectionLabel('Voice input')}
      <VStack align="stretch" gap={2}>
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

        {/* ── R-4 — Model audio status (#2897 ST-6 / REQ-7) ──────────────── */}
        {/* UNCONDITIONAL (Spec #2914 ST-3): there is ONE voice path, so the
            backend-owned capability verdict is always shown. The capability is
            never inferred from a model name; a not-ready verdict shows the row's
            sentence and never blocks the group or companion chat. */}
        <Box
          data-testid="companion-voice-model-audio-row"
          data-state={modelAudioRow.state}
          p={3}
          borderRadius="md"
          bg={modelAudioRowTint(modelAudioRow.state).bg}
          border="1px solid"
          borderColor={modelAudioRowTint(modelAudioRow.state).borderColor}
        >
          <VStack align="stretch" gap={2}>
            <HStack justify="space-between" align="flex-start" gap={2}>
              <VStack align="start" gap={0} minW="0" flex={1}>
                <HStack gap={1} align="center">
                  <Icon
                    as={
                      modelAudioRow.state === 'ready'
                        ? LuCircleCheck
                        : modelAudioRow.state === 'checking'
                          ? LuCircleDashed
                          : modelAudioRow.state === 'unsupported'
                            ? LuCircleX
                            : LuTriangleAlert
                    }
                    boxSize="14px"
                    color={
                      modelAudioRow.state === 'ready'
                        ? 'status.success'
                        : modelAudioRow.state === 'unknown'
                          ? 'status.error'
                          : modelAudioRow.state === 'checking'
                            ? 'var(--text-subtle)'
                            : 'status.warning'
                    }
                    aria-hidden
                  />
                  <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                    Model audio status
                  </Text>
                </HStack>
                <Text
                  data-testid="companion-voice-model-audio-status"
                  data-state={modelAudioRow.state}
                  fontSize="xs"
                  color={modelAudioRowColor(modelAudioRow.state)}
                >
                  {modelAudioRow.sentence}
                </Text>
              </VStack>

              {(modelAudioRow.offerChangeModel || modelAudioRow.offerRetry) && (
                <HStack gap={1} align="center" flexShrink={0}>
                  {modelAudioRow.offerChangeModel && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="companion-voice-model-audio-change-model"
                      aria-label={MODEL_AUDIO_CHANGE_MODEL_LABEL}
                      color="var(--text-primary)"
                      onClick={handleChangeModel}
                      _hover={{ bg: 'var(--hover-bg)' }}
                    >
                      {MODEL_AUDIO_CHANGE_MODEL_LABEL}
                    </Button>
                  )}
                  {modelAudioRow.offerRetry && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="companion-voice-model-audio-retry"
                      aria-label={MODEL_AUDIO_RETRY_LABEL}
                      color="var(--text-primary)"
                      onClick={handleRetryModelAudio}
                      disabled={modelAudioChecking}
                      _hover={{ bg: 'var(--hover-bg)' }}
                    >
                      <Icon as={LuRefreshCw} boxSize="14px" mr={1} aria-hidden />
                      {MODEL_AUDIO_RETRY_LABEL}
                    </Button>
                  )}
                </HStack>
              )}
            </HStack>

            {/* The backend qualifier is demoted to a labelled mono line — the
                curated sentence above is the primary message. */}
            {modelAudioProbeDetail(modelAudioCapability, modelAudioRow.state) && (
              <Text
                fontSize="11px"
                fontFamily="mono"
                color="var(--text-subtle)"
                wordBreak="break-all"
              >
                Technical details: {modelAudioProbeDetail(modelAudioCapability, modelAudioRow.state)}
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
