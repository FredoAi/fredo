/**
 * CompanionSettingsPanel — the voice input group host (refreshed by #2914 ST-3).
 *
 * Proves the observable contract without a Tauri host:
 *   1. the READY branch renders the reduced "Voice input" group with the opt-in
 *      toggle DEFAULTING to false and persisting `Fredo_companion_voice_enabled`;
 *   2. the voice group renders INSIDE the existing Companion section — no new
 *      settings nav item and no dedicated Voice section;
 *   3. the model-audio capability row + the device selector + the one persistent
 *      settings live region render under that group, and the device choice
 *      persists (`Fredo_companion_voice_device_id`);
 *   4. the STT model never gates companion chat — the controls still render when
 *      the probe is unavailable;
 *   5. AC1 (negative): none of the removed local affordances (handling selector,
 *      STT model row/download, autosend toggle, engine-status line) render.
 *
 * The wizard's `sttModel` step removal is ST-4's slice; this file also pins that
 * the step is ABSENT and the required-step summary counts only the GGUF/server
 * prerequisites.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  useCompanion,
  VOICE_ENABLED_SETTING_KEY,
  VOICE_DEVICE_ID_SETTING_KEY,
} from '@/shared/contexts/CompanionContext';
import { CompanionSettingsPanel } from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  CompanionReadiness,
  LlamaServerStatus,
  SttDevicesResult,
} from '@/shared/components/companion/companionReadiness';

const bothInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    {
      id: 'llamaServer',
      state: 'installed',
      detail: 'llama-server found.',
      resolvedPath: 'C:\\llama\\llama-server.exe',
    },
    {
      id: 'modelFiles',
      state: 'installed',
      detail: 'All required model files present.',
      resolvedPath: 'C:\\models',
    },
  ],
};

/** One required step installed, one missing — the wizard stays. */
const partiallyReady: CompanionReadiness = {
  ready: false,
  prerequisites: [
    {
      id: 'llamaServer',
      state: 'installed',
      detail: 'llama-server found.',
      resolvedPath: 'C:\\llama\\llama-server.exe',
    },
    {
      id: 'modelFiles',
      state: 'missing',
      detail: '0 of 3 model files present.',
      resolvedPath: null,
    },
  ],
};

function healthyServer(): LlamaServerStatus {
  return {
    running: true,
    healthy: true,
    port: 8080,
    pid: 1,
    configPath: 'C:\\data\\companion\\llama-server-launch.bat',
    logPath: 'C:\\data\\companion\\llama-server.log',
    lastError: null,
  };
}

/** Server present but not started — composes the third REQUIRED step. */
function notRunningServer(): LlamaServerStatus {
  return {
    running: false,
    healthy: false,
    port: null,
    pid: null,
    configPath: '',
    logPath: '',
    lastError: null,
  };
}

const sttDevices: SttDevicesResult = {
  devices: [
    { id: 'Microphone (USB)', name: 'Microphone (USB)', isDefault: true },
    { id: 'Iriun Webcam', name: 'Iriun Webcam', isDefault: false },
  ],
  selectedId: null,
  code: null,
};

/** Observable voice-input preference (mirrors the CompanionStateProbe pattern). */
function VoiceProbe() {
  const { voiceEnabled } = useCompanion();
  return <div data-testid="voice-probe" data-enabled={String(voiceEnabled)} />;
}

/** The removed local affordances that must NEVER render (AC1, G-187). */
const REMOVED_VOICE_TESTIDS = [
  'companion-voice-handling-row',
  'companion-voice-handling-select',
  'companion-voice-model-row',
  'companion-voice-model-status',
  'companion-voice-model-download',
  'companion-voice-model-recheck',
  'companion-voice-model-progress',
  'companion-voice-model-location',
  'companion-voice-model-audio-use-local',
  'companion-voice-engine-status',
  'companion-voice-autosend',
] as const;

function expectNoLocalAffordances(): void {
  for (const testid of REMOVED_VOICE_TESTIDS) {
    expect(screen.queryByTestId(testid)).toBeNull();
  }
  expect(screen.queryByRole('option', { name: 'Local transcription' })).toBeNull();
}

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
});

describe('CompanionSettingsPanel voice input group (#2914 ST-3)', () => {
  it('renders the reduced group in the ready branch with the toggle OFF by default and persists ON', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_list_devices') return sttDevices;
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    renderWithChakra(
      <CompanionProvider>
        <CompanionSettingsPanel />
        <VoiceProbe />
      </CompanionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('companion-controls')).toBeInTheDocument();
    });

    // The enable label teaches hold-Space, not the retired Ctrl+Space shortcut.
    expect(screen.getByText('Hold Space to dictate')).toBeInTheDocument();
    expect(screen.queryByText('Dictate with Ctrl+Space')).toBeNull();
    // Opt-in / privacy-first: OFF until the user turns it on, nothing persisted.
    expect(screen.getByTestId('voice-probe').getAttribute('data-enabled')).toBe('false');
    expect(localStorage.getItem(VOICE_ENABLED_SETTING_KEY)).toBeNull();

    // The retained controls render; the removed local affordances do NOT.
    expect(screen.getByTestId('companion-voice-model-audio-row')).toBeInTheDocument();
    expect(screen.getByTestId('companion-voice-device-select')).toBeInTheDocument();
    expect(screen.getByTestId('companion-voice-settings-announcer')).toBeInTheDocument();
    expectNoLocalAffordances();

    fireEvent.click(screen.getByLabelText('Enable voice input'));

    await waitFor(() => {
      expect(screen.getByTestId('voice-probe').getAttribute('data-enabled')).toBe('true');
    });
    expect(localStorage.getItem(VOICE_ENABLED_SETTING_KEY)).toBe('true');
  });

  it('never gates companion chat on the STT model (probe unavailable → controls still render)', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      return undefined; // every STT probe unavailable
    });
    adapterBridge.setListen(async () => () => {});

    renderWithChakra(
      <CompanionProvider>
        <CompanionSettingsPanel />
      </CompanionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('companion-controls')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('companion-setup-wizard')).toBeNull();
    // Voice still works: the retained group renders with a fail-closed verdict.
    expect(screen.getByLabelText('Enable voice input')).toBeInTheDocument();
    expect(screen.getByTestId('companion-voice-model-audio-row')).toBeInTheDocument();
    expectNoLocalAffordances();
  });

  it('drops the sttModel wizard step and keeps the required-step summary unchanged', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'check_companion_readiness') return partiallyReady;
      if (command === 'get_llama_server_status') return notRunningServer();
      return undefined;
    });
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    renderWithChakra(
      <CompanionProvider>
        <CompanionSettingsPanel />
      </CompanionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    });

    // The summary counts the THREE required steps only (llamaServer installed,
    // modelFiles missing, serverLaunch not started) — the removed STT model step
    // never inflates the total.
    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-summary')).toHaveTextContent(
        '1 of 3 prerequisites ready',
      );
    });
    expect(screen.getByTestId('companion-setup-summary')).not.toHaveTextContent('1 of 4');

    // #2914 ST-4 — the STT model step and its optional group are GONE.
    expect(screen.queryByTestId('companion-step-stt-model')).toBeNull();
    expect(screen.queryByTestId('companion-setup-optional')).toBeNull();
    expect(screen.queryByText('Voice input model')).toBeNull();

    // The removed STT-model commands are never invoked.
    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain('stt_check_model');
    expect(commands).not.toContain('download_stt_model');

    // The not-ready gate keeps rendering the wizard ONLY (no controls).
    expect(screen.queryByTestId('companion-controls')).toBeNull();
  });
});

// ── #2877 ST-4 / #2914 ST-3 — the extracted VoiceInputSettings group ─────────

describe('CompanionSettingsPanel voice group placement + status (#2914 ST-3)', () => {
  function renderReady() {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_list_devices') return sttDevices;
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});
    return renderWithChakra(
      <CompanionProvider>
        <CompanionSettingsPanel />
      </CompanionProvider>,
    );
  }

  it('renders the voice group INSIDE the existing Companion section (no new nav item/section)', async () => {
    renderReady();

    const section = await screen.findByTestId('companion-controls');
    // The voice group lives in the existing Companion section.
    expect(within(section).getByText('Voice input')).toBeInTheDocument();
    expect(within(section).getByText('Hold Space to dictate')).toBeInTheDocument();
    // No dedicated Voice section heading was added anywhere.
    expect(screen.queryByRole('heading', { name: 'Voice' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Voice input' })).toBeNull();
  });

  it('shows the model-audio row + the settings live region (no model row / engine status)', async () => {
    renderReady();

    await screen.findByTestId('companion-controls');
    await waitFor(() => {
      expect(screen.getByTestId('companion-voice-model-audio-row')).toBeInTheDocument();
    });
    // The removed local affordances are absent.
    expect(screen.queryByTestId('companion-voice-model-row')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-location')).toBeNull();
    expect(screen.queryByTestId('companion-voice-engine-status')).toBeNull();
    // DR-10 — one persistent polite live region for settings changes.
    const announcer = screen.getByTestId('companion-voice-settings-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
  });

  it('renders the device selector and persists its value (autosend removed)', async () => {
    renderReady();

    const select = (await screen.findByTestId(
      'companion-voice-device-select',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'Iriun Webcam' })).toBeInTheDocument();
    });
    fireEvent.change(select, { target: { value: 'Iriun Webcam' } });
    await waitFor(() => {
      expect(localStorage.getItem(VOICE_DEVICE_ID_SETTING_KEY)).toBe('Iriun Webcam');
    });

    // #2914 ST-3 (R-1) — the transcript-only autosend switch is gone.
    expect(screen.queryByTestId('companion-voice-autosend')).toBeNull();
    expect(screen.queryByLabelText('Send voice transcripts automatically')).toBeNull();
    expectNoLocalAffordances();
  });
});
