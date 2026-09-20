/**
 * VoiceInputSettings — #2914 ST-3 unit contract (the single model-audio mode).
 *
 * Proves the reduced settings group without a Tauri host:
 *   • AC1 (negative) — the group has NO speech-handling selector (and therefore
 *     no `Local transcription` option), NO STT model row / download / re-check /
 *     progress / location, NO engine-status line and NO autosend toggle: no
 *     affordance selects, installs or repairs a local on-device engine;
 *   • C1 — the master enable switch (frozen `aria-label="Enable voice input"`,
 *     label `Hold Space to dictate`, help id `companion-voice-enable-help`,
 *     DEFAULT OFF) persists `Fredo_companion_voice_enabled` and, on OFF while a
 *     session is live, stops the session + releases the mic (R-1.1 / DR-2);
 *   • R-4 — the model-audio capability row renders UNCONDITIONALLY, derives its
 *     sentence/actions from the backend verdict (never a raw IPC string), offers
 *     NO local fallback, and `Try again` / `Change model` behave;
 *   • C3 — the `chakra.select` device selector (never `NativeSelect`) with
 *     System-default + enumerated devices, the checking / no-device / vanished /
 *     permission-denied sub-states + Re-scan, persisted
 *     `Fredo_companion_voice_device_id`, and NO silent switch for a vanished
 *     selection (R-3.2 / R-5.1 / AC4);
 *   • DR-10 — one persistent polite live region for settings state changes;
 *   • DR-12 — token-first source pins (no `var(--x)NN` alpha-append, `tint()`
 *     for every alpha, unit-string geometry) + AC1 source absence pins.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  VOICE_ENABLED_SETTING_KEY,
  VOICE_DEVICE_ID_SETTING_KEY,
} from '@/shared/contexts/CompanionContext';
import {
  VoiceInputSettings,
  deriveDeviceRowView,
  voiceErrorCopyFor,
} from '@/shared/components/companion/VoiceInputSettings';
import type { VoiceInputSettingsProps } from '@/shared/components/companion/VoiceInputSettings';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { SttDeviceProbe } from '@/shared/components/companion/companionReadiness';

// ── #2882 ST-7 pinned copy (R-7) — retained byte-identical by #2914 ST-3 ─────
const VOICE_ENABLE_LABEL = 'Hold Space to dictate';
const VOICE_ENABLE_HELP_TEXT =
  'In the launcher search bar, hold Space to dictate; release and the words land in the bar as ' +
  'editable text. Enter then sends them to Fredo — with “Send voice transcripts automatically” ' +
  'on, they’re sent the moment you release. A dictated transcript always goes to Fredo and never ' +
  'opens an app, even after you edit it. Ctrl+Space only brings the search bar forward; it never ' +
  'starts dictation. Transcription runs locally — nothing leaves this machine.';
const VOICE_DISABLED_ERROR_TEXT =
  'Voice input is off. Turn on “Hold Space to dictate” above, then hold Space in the launcher search bar.';

function deviceProbe(overrides: Partial<SttDeviceProbe> = {}): SttDeviceProbe {
  return {
    state: 'devices',
    devices: [
      { id: 'Microphone (USB)', name: 'Microphone (USB)', isDefault: true },
      { id: 'Iriun Webcam', name: 'Iriun Webcam', isDefault: false },
    ],
    selectedId: null,
    code: null,
    ...overrides,
  };
}

// ── Listen mock (drives the app-global stt:* stream) ─────────────────────────

let listenHandlers = new Map<string, Array<(payload: unknown) => void>>();

function installListenMock(): void {
  listenHandlers = new Map();
  adapterBridge.setListen(async <T,>(event: string, handler: (payload: T) => void) => {
    const list = listenHandlers.get(event) ?? [];
    list.push(handler as (payload: unknown) => void);
    listenHandlers.set(event, list);
    return () => {};
  });
}

function emitEvent(event: string, payload: unknown): void {
  for (const handler of listenHandlers.get(event) ?? []) handler(payload);
}

function renderSettings(overrides: Partial<VoiceInputSettingsProps> = {}) {
  const props: VoiceInputSettingsProps = {
    sttDevices: deviceProbe(),
    onRescanDevices: vi.fn(),
    ...overrides,
  };
  const utils = renderWithChakra(
    <CompanionProvider>
      <VoiceInputSettings {...props} />
    </CompanionProvider>,
  );
  return { ...utils, props };
}

/** The backend capability probe used by the model-audio row. */
const installCapability = (result: unknown) => {
  adapterBridge.setInvoke((async (command: string) =>
    command === 'stt_audio_capability' ? result : undefined) as never);
};

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  adapterBridge.setInvoke(async () => undefined);
  installListenMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
});

// ── Pure derivations ─────────────────────────────────────────────────────────

describe('VoiceInputSettings — pure derivations (#2914 ST-3)', () => {
  it('curates the error copy (never a raw IPC string) with no local fallback', () => {
    expect(voiceErrorCopyFor('permissionDenied')).toMatch(/Windows Settings/);
    expect(voiceErrorCopyFor('noDevice')).toMatch(/Connect a microphone/);
    expect(voiceErrorCopyFor(null)).toMatch(/unexpected problem/);
    // #2882 ST-7 retained (G-125): the `disabled` copy points at the enable label
    // and never names Ctrl+Space as the dictation shortcut.
    expect(voiceErrorCopyFor('disabled')).toBe(VOICE_DISABLED_ERROR_TEXT);
    expect(voiceErrorCopyFor('disabled')).not.toMatch(/Ctrl\+Space/);
    // #2914 ST-3 (R-3): the model-audio copy never offers the removed local path.
    expect(voiceErrorCopyFor('modelAudioUnsupported')).not.toMatch(/Local transcription/);
    expect(voiceErrorCopyFor('modelAudioUnavailable')).not.toMatch(/Local transcription/);
    expect(voiceErrorCopyFor('modelAudioUnsupported')).toMatch(/install a model with audio support/i);
  });

  it('derives the device sub-states (vanished is never a silent switch)', () => {
    const vanished = deriveDeviceRowView({
      probe: deviceProbe({ state: 'vanished', selectedId: 'Gone' }),
      selectedId: 'Gone',
      deviceCount: 2,
    });
    expect(vanished.state).toBe('vanished');
    expect(vanished.warning).toBe(true);
    expect(vanished.help).toMatch(/never switches devices/i);
    // A persisted id absent from the enumeration is vanished even when the probe
    // still reports `devices` — derivable from the persisted context value.
    expect(
      deriveDeviceRowView({
        probe: deviceProbe(),
        selectedId: 'Gone',
        deviceCount: 2,
      }).state,
    ).toBe('vanished');
    expect(
      deriveDeviceRowView({
        probe: deviceProbe({ state: 'no-device', devices: [] }),
        selectedId: null,
        deviceCount: 0,
      }).state,
    ).toBe('no-device');
    expect(
      deriveDeviceRowView({
        probe: deviceProbe({ state: 'permissionDenied' }),
        selectedId: null,
        deviceCount: 2,
      }).state,
    ).toBe('permission-denied');
  });
});

// ── AC1 — the group has NO local-mode affordance ─────────────────────────────

describe('VoiceInputSettings — AC1 no local-mode affordance (#2914 ST-3)', () => {
  it('renders exactly the retained controls and NONE of the removed local affordances', () => {
    renderSettings();

    // REMOVED (AC1): the speech-handling selector, the STT model row, the
    // engine-status line and the autosend toggle.
    expect(screen.queryByTestId('companion-voice-handling-row')).toBeNull();
    expect(screen.queryByTestId('companion-voice-handling-select')).toBeNull();
    expect(screen.queryByTestId('companion-voice-handling-help')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-row')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-status')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-download')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-recheck')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-progress')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-location')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
    expect(screen.queryByTestId('companion-voice-engine-status')).toBeNull();
    expect(screen.queryByTestId('companion-voice-autosend')).toBeNull();

    // No option selects local transcription; no engine name is shown.
    expect(screen.queryByRole('option', { name: 'Local transcription' })).toBeNull();
    expect(screen.queryByText(/Streaming Zipformer/)).toBeNull();
    expect(screen.queryByText('Send transcripts automatically')).toBeNull();

    // RETAINED: enable toggle + model-audio row + device select + announcer.
    expect(screen.getByLabelText('Enable voice input')).toBeInTheDocument();
    expect(screen.getByTestId('companion-voice-model-audio-row')).toBeInTheDocument();
    expect(screen.getByTestId('companion-voice-device-select')).toBeInTheDocument();
    expect(screen.getByTestId('companion-voice-settings-announcer')).toBeInTheDocument();
  });
});

// ── C1 — master enable (R-1.1 / DR-2) ────────────────────────────────────────

describe('VoiceInputSettings — C1 enable switch (#2914 ST-3)', () => {
  it('renders the pinned label + help and defaults OFF (opt-in)', async () => {
    renderSettings();

    expect(screen.getByText(VOICE_ENABLE_LABEL)).toBeInTheDocument();
    expect(screen.queryByText('Dictate with Ctrl+Space')).toBeNull();
    const help = screen.getByText(VOICE_ENABLE_HELP_TEXT);
    expect(help).toBeInTheDocument();
    expect(help).toHaveAttribute('id', 'companion-voice-enable-help');
    const toggle = screen.getByLabelText('Enable voice input');
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem(VOICE_ENABLED_SETTING_KEY)).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    await waitFor(() => {
      expect(localStorage.getItem(VOICE_ENABLED_SETTING_KEY)).toBe('true');
    });
  });

  it('toggling OFF while listening stops the session and releases the mic', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    const invoke = vi.fn(async () => undefined);
    adapterBridge.setInvoke(invoke);

    renderSettings();

    const toggle = await screen.findByLabelText('Enable voice input');
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    // Wait for the stt:state subscription to register, then make the session live.
    await waitFor(() => {
      expect(listenHandlers.get('stt:state')?.length ?? 0).toBeGreaterThan(0);
    });
    await act(async () => {
      emitEvent('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('stt_stop', undefined);
    });
    expect(toggle).not.toBeChecked();
  });
});

// ── R-4 — model audio status (unconditional) ─────────────────────────────────

describe('VoiceInputSettings — R-4 model audio status (#2914 ST-3)', () => {
  const capabilityRow = () => screen.getByTestId('companion-voice-model-audio-row');
  const capabilityStatus = () => screen.getByTestId('companion-voice-model-audio-status');

  it('renders UNCONDITIONALLY with a fail-closed unknown verdict while voice is off', () => {
    renderSettings();
    expect(capabilityRow()).toHaveAttribute('data-state', 'unknown');
    expect(capabilityStatus()).toHaveTextContent("Can't check audio support right now.");
    expect(screen.getByTestId('companion-voice-model-audio-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
  });

  it('renders even with a stale `local` handling value persisted (single mode, R-4)', async () => {
    localStorage.setItem('Fredo_companion_voice_handling', 'local');
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    installCapability({
      state: 'ready',
      model: 'Gemma-4-E2B',
      limitMs: null,
      code: null,
      detail: null,
    });
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'ready'));
  });

  it('checking: renders the in-flight sentence and no action', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    // A capability probe that never settles keeps the UI-side `checking` state
    // observable.
    adapterBridge.setInvoke((async (command: string) => {
      if (command === 'stt_audio_capability') return new Promise(() => {});
      return undefined;
    }) as never);
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'checking'));
    expect(capabilityStatus()).toHaveTextContent(
      "Checking the companion model's audio support…",
    );
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-audio-change-model')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-audio-retry')).toBeNull();
  });

  it('ready: names the reported model and offers no action', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    installCapability({
      state: 'ready',
      model: 'Gemma-4-E2B',
      limitMs: null,
      code: null,
      detail: null,
    });
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'ready'));
    expect(capabilityStatus()).toHaveTextContent(
      'Gemma-4-E2B can interpret audio. Recordings stay on this machine.',
    );
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-audio-retry')).toBeNull();
  });

  it('unsupported: warns and offers Change model (never a local fallback)', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    installCapability({
      state: 'unsupported',
      model: 'Gemma-4-E2B',
      limitMs: null,
      code: 'modelAudioUnsupported',
      detail: 'HTTP 400: unsupported content part',
    });
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'unsupported'));
    expect(capabilityStatus()).toHaveTextContent(
      "The installed companion model can't interpret audio. Recordings won't be sent.",
    );
    // The raw backend detail is demoted, never the primary sentence.
    expect(capabilityRow()).toHaveTextContent(/Technical details: HTTP 400/);
    // No local-mode action survives; `Change model` is the reachable remediation.
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
    const changeModel = screen.getByTestId('companion-voice-model-audio-change-model');
    expect(changeModel).toHaveTextContent('Change model');
    fireEvent.click(changeModel);
    expect(screen.getByTestId('companion-voice-settings-announcer')).toHaveTextContent(
      'Install a companion model with audio support from Companion setup.',
    );
  });

  it('server-unavailable: warns and Try again re-probes + announces', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    const invoke = vi.fn(async (command: string) =>
      command === 'stt_audio_capability'
        ? {
            state: 'serverUnavailable',
            model: null,
            limitMs: null,
            code: 'modelAudioUnavailable',
            detail: 'connection refused',
          }
        : undefined,
    );
    adapterBridge.setInvoke(invoke as never);
    renderSettings();
    await waitFor(() =>
      expect(capabilityRow()).toHaveAttribute('data-state', 'server-unavailable'),
    );
    expect(capabilityStatus()).toHaveTextContent(
      "The local model server isn't running, so Fredo can't interpret audio.",
    );
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();

    const probes = () =>
      invoke.mock.calls.filter((call) => call[0] === 'stt_audio_capability').length;
    const before = probes();
    fireEvent.click(screen.getByTestId('companion-voice-model-audio-retry'));
    await waitFor(() => {
      expect(probes()).toBeGreaterThan(before);
    });
    expect(screen.getByTestId('companion-voice-settings-announcer')).toHaveTextContent(
      "Checking the companion model's audio support again.",
    );
  });

  it('unknown: fail-closed copy + Try again + the demoted detail', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    installCapability({
      state: 'unknown',
      model: null,
      limitMs: null,
      code: null,
      detail: 'HTTP 500',
    });
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'unknown'));
    expect(capabilityStatus()).toHaveTextContent("Can't check audio support right now.");
    expect(capabilityRow()).toHaveTextContent(/Technical details: HTTP 500/);
    expect(screen.getByTestId('companion-voice-model-audio-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
  });

  it('a rejected / malformed probe is `unknown`, never `ready`', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    adapterBridge.setInvoke((async (command: string) => {
      if (command === 'stt_audio_capability') throw new Error('command unavailable');
      return undefined;
    }) as never);
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'unknown'));
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
  });
});

// ── C3 — device selection (DR-5 / R-3.2 / R-5.1) ──────────────────────────────

describe('VoiceInputSettings — C3 device selection (#2914 ST-3)', () => {
  it('renders a chakra select with System default + enumerated devices and persists the choice', async () => {
    renderSettings({ sttDevices: deviceProbe() });

    const select = screen.getByTestId('companion-voice-device-select') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(within(select).getByRole('option', { name: 'System default' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Microphone (USB)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Iriun Webcam' })).toBeInTheDocument();
    expect(select.value).toBe('');
    expect(screen.queryByTestId('companion-voice-device-rescan')).toBeNull();

    fireEvent.change(select, { target: { value: 'Iriun Webcam' } });

    await waitFor(() => {
      expect(localStorage.getItem(VOICE_DEVICE_ID_SETTING_KEY)).toBe('Iriun Webcam');
    });
    expect(select.value).toBe('Iriun Webcam');
  });

  it('vanished: shows the warning + Re-scan and does NOT silently switch devices', async () => {
    localStorage.setItem(VOICE_DEVICE_ID_SETTING_KEY, 'Gone mic');
    renderSettings({
      sttDevices: deviceProbe({ state: 'vanished', selectedId: 'Gone mic' }),
    });

    const select = (await screen.findByTestId(
      'companion-voice-device-select',
    )) as HTMLSelectElement;
    // The persisted selection is preserved (no silent fallback to System default).
    await waitFor(() => {
      expect(select.value).toBe('Gone mic');
    });
    expect(within(select).getByRole('option', { name: /Gone mic — not available/ })).toBeDisabled();
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /isn't available/,
    );
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /never switches devices on its own/,
    );
    expect(screen.getByTestId('companion-voice-device-rescan')).toBeInTheDocument();
  });

  it('no-device: disables the selector and names the next step', () => {
    renderSettings({
      sttDevices: deviceProbe({ state: 'no-device', devices: [], selectedId: null }),
    });
    expect(screen.getByTestId('companion-voice-device-select')).toBeDisabled();
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /No microphone found/,
    );
    expect(screen.getByTestId('companion-voice-device-rescan')).toBeInTheDocument();
  });

  it('permission-denied: actionable privacy-settings copy + Re-scan', () => {
    renderSettings({ sttDevices: deviceProbe({ state: 'permissionDenied' }) });
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /Windows Settings → Privacy → Microphone/,
    );
    expect(screen.getByTestId('companion-voice-device-rescan')).toBeInTheDocument();
  });

  it('checking: disables the selector while the enumeration is in flight', () => {
    renderSettings({
      sttDevices: deviceProbe({ state: 'checking', devices: [], selectedId: null }),
    });
    expect(screen.getByTestId('companion-voice-device-select')).toBeDisabled();
    expect(
      within(screen.getByTestId('companion-voice-device-select')).getByRole('option', {
        name: 'Checking microphones…',
      }),
    ).toBeInTheDocument();
  });

  it('Re-scan invokes the device re-probe callback', () => {
    const onRescanDevices = vi.fn();
    renderSettings({
      sttDevices: deviceProbe({ state: 'no-device', devices: [], selectedId: null }),
      onRescanDevices,
    });
    fireEvent.click(screen.getByTestId('companion-voice-device-rescan'));
    expect(onRescanDevices).toHaveBeenCalledTimes(1);
  });
});

// ── DR-10 — settings live region ─────────────────────────────────────────────

describe('VoiceInputSettings — DR-10 live region (#2914 ST-3)', () => {
  it('renders one persistent polite live region that announces settings changes', async () => {
    renderSettings();

    const announcer = screen.getByTestId('companion-voice-settings-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(screen.getByLabelText('Enable voice input'));
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Voice input is on.');
    });
  });
});

// ── DR-12 — token / geometry source pins ─────────────────────────────────────

describe('VoiceInputSettings — DR-12 token + geometry pins (#2914 ST-3)', () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      'src/shared/components/companion/VoiceInputSettings.tsx',
    ),
    'utf8',
  );

  it('never alpha-appends onto a var() — every alpha goes through tint()', () => {
    expect(source).not.toMatch(/var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/);
    expect(source).toContain('tint(');
  });

  it('uses chakra.select (never NativeSelect) with theme CSS-var props', () => {
    expect(source).not.toMatch(/<NativeSelect|NativeSelect\./);
    expect(source).toContain('chakra.select');
    expect(source).toContain('bg="var(--card-bg)"');
    expect(source).toContain('borderColor="var(--border-color)"');
    expect(source).toContain('height="32px"');
    expect(source).toContain('maxWidth="260px"');
  });

  it('states geometry as CSS unit strings (never a bare numeric size prop)', () => {
    expect(source).toContain('width="1px"');
    expect(source).toContain('height="1px"');
    expect(source).not.toMatch(/boxSize=\{?\d/);
  });

  it('keeps ZERO local-mode source affordances (AC1, G-187)', () => {
    expect(source).not.toContain('companion-voice-handling');
    expect(source).not.toContain('companion-voice-model-row');
    expect(source).not.toContain('companion-voice-autosend');
    expect(source).not.toContain('companion-voice-engine-status');
    expect(source).not.toContain('Local transcription');
    expect(source).not.toContain('Streaming Zipformer');
    expect(source).not.toContain('MODEL_AUDIO_USE_LOCAL_LABEL');
    expect(source).not.toContain('VOICE_ENGINE_NAME');
  });
});
