/**
 * CompanionSettingsPanel — #2876 ST-5 voice input group + optional STT setup step,
 * refreshed for #2877 ST-4 (the extracted `VoiceInputSettings` group).
 *
 * Proves the observable contract without a Tauri host:
 *   1. the READY branch renders a "Voice input" group with an opt-in toggle that
 *      DEFAULTS to false and persists `Fredo_companion_voice_enabled` on change;
 *   2. the STT model NEVER gates companion chat — the controls still render when
 *      `stt_check_model` is unavailable (the readiness gate keeps exactly today's
 *      inputs: backend readiness + a healthy managed server);
 *   3. the optional `sttModel` step is rendered in a separate OPTIONAL group and is
 *      EXCLUDED from the wizard's `installed/total` summary.
 *
 * #2877 ST-4 extensions (added, never weakening the pins above):
 *   4. the voice group renders INSIDE the existing Companion section — no new
 *      settings nav item and no dedicated Voice section;
 *   5. the model row shows the resolved location on ready, the engine status line
 *      and the one persistent settings live region;
 *   6. the device selector + autosend switch render under the same group and
 *      persist their values (`Fredo_companion_voice_device_id`,
 *      `Fredo_companion_voice_autosend`);
 *   7. #2882 ST-7 re-points the enable label/help onto the hold-Space gesture —
 *      the retired Ctrl+Space dictation shortcut is gone from the copy.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  useCompanion,
  VOICE_ENABLED_SETTING_KEY,
  VOICE_AUTOSEND_SETTING_KEY,
  VOICE_DEVICE_ID_SETTING_KEY,
} from '@/shared/contexts/CompanionContext';
import { CompanionSettingsPanel } from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  CompanionReadiness,
  LlamaServerStatus,
  ModelFileId,
  ModelFileStatus,
  ModelFileState,
  SttDevicesResult,
  SttModelStatus,
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

const STT_IDS = ['sttTokens', 'sttEncoder', 'sttDecoder', 'sttJoiner'] as const;

function sttFile(id: ModelFileId, state: ModelFileState): ModelFileStatus {
  return {
    id,
    filename: `${id}.bin`,
    relativePath: `${id}.bin`,
    state,
    downloadedBytes: state === 'present' ? 10 : 0,
    expectedBytes: 10,
    detail: null,
    path: state === 'present' ? `C:\\models\\${id}` : null,
  };
}

const sttReady: SttModelStatus = {
  ready: true,
  files: STT_IDS.map((id) => sttFile(id, 'present')),
};

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

describe('CompanionSettingsPanel voice input group (#2876 ST-5)', () => {
  it('renders the group in the ready branch with the toggle OFF by default and persists ON', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_check_model') return sttReady;
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

    // #2882 ST-7 re-pinned (G-125): the enable label teaches hold-Space, not the
    // retired Ctrl+Space dictation shortcut.
    expect(screen.getByText('Hold Space to dictate')).toBeInTheDocument();
    expect(screen.queryByText('Dictate with Ctrl+Space')).toBeNull();
    // Opt-in / privacy-first: OFF until the user turns it on, nothing persisted.
    expect(screen.getByTestId('voice-probe').getAttribute('data-enabled')).toBe('false');
    expect(localStorage.getItem(VOICE_ENABLED_SETTING_KEY)).toBeNull();
    // The model row shows the installed state.
    expect(screen.getByTestId('companion-voice-model-download')).toHaveTextContent('Installed');

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
      return undefined; // stt_check_model unavailable
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
    expect(screen.getByTestId('companion-voice-model-download')).toHaveTextContent('Download');
  });

  it('excludes the optional sttModel step from the wizard installed/total summary', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return partiallyReady;
      if (command === 'stt_check_model') return sttReady;
      return undefined; // get_llama_server_status unavailable → serverLaunch not composed
    });
    adapterBridge.setListen(async () => () => {});

    renderWithChakra(
      <CompanionProvider>
        <CompanionSettingsPanel />
      </CompanionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    });

    // The summary counts REQUIRED steps only: 1 of 2 (llamaServer installed,
    // modelFiles missing) — the installed optional sttModel must not appear.
    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-summary')).toHaveTextContent(
        '1 of 2 prerequisites ready',
      );
    });
    expect(screen.getByTestId('companion-setup-summary')).not.toHaveTextContent('1 of 3');

    // The optional step is rendered in its own explicitly-optional group.
    expect(screen.getByTestId('companion-setup-optional')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-stt-model')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-stt-model')).toHaveAttribute(
      'data-state',
      'installed',
    );

    // The not-ready gate keeps rendering the wizard ONLY (no controls).
    expect(screen.queryByTestId('companion-controls')).toBeNull();
  });
});

// ── #2877 ST-4 — the extracted VoiceInputSettings group ──────────────────────

describe('CompanionSettingsPanel voice group placement + status (#2877 ST-4)', () => {
  function renderReady() {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_check_model') return sttReady;
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
    // #2882 ST-7 re-pinned (G-125) — the group still lives in the Companion section.
    expect(within(section).getByText('Hold Space to dictate')).toBeInTheDocument();
    // No dedicated Voice section heading was added anywhere.
    expect(screen.queryByRole('heading', { name: 'Voice' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Voice input' })).toBeNull();
  });

  it('shows the resolved model location on ready + the engine status + settings live region', async () => {
    renderReady();

    await screen.findByTestId('companion-controls');
    await waitFor(() => {
      expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
        'data-state',
        'installed',
      );
    });
    // AC2 — the resolved on-disk location (derived from the per-file paths).
    await waitFor(() => {
      expect(screen.getByTestId('companion-voice-model-location')).toHaveTextContent(
        'C:\\models',
      );
    });
    // R-1.3 — the engine status line is present and idle by default.
    expect(screen.getByTestId('companion-voice-engine-status')).toHaveAttribute(
      'data-state',
      'idle',
    );
    // DR-10 — one persistent polite live region for settings changes.
    const announcer = screen.getByTestId('companion-voice-settings-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
  });

  it('renders the device selector + autosend switch and persists their values', async () => {
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

    // Autosend defaults OFF and persists ON.
    const autosend = screen.getByLabelText('Send voice transcripts automatically');
    expect(autosend).not.toBeChecked();
    expect(localStorage.getItem(VOICE_AUTOSEND_SETTING_KEY)).toBeNull();
    fireEvent.click(autosend);
    await waitFor(() => {
      expect(localStorage.getItem(VOICE_AUTOSEND_SETTING_KEY)).toBe('true');
    });
    expect(
      screen.getByText('Transcripts are sent as soon as you stop — no review.'),
    ).toBeInTheDocument();
  });
});
