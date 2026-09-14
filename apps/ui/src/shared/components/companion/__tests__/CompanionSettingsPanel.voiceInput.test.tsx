/**
 * CompanionSettingsPanel — #2876 ST-5 voice input group + optional STT setup step.
 *
 * Proves the observable contract without a Tauri host:
 *   1. the READY branch renders a "Voice input" group with an opt-in toggle that
 *      DEFAULTS to false and persists `Fredo_companion_voice_enabled` on change;
 *   2. the STT model NEVER gates companion chat — the controls still render when
 *      `stt_check_model` is unavailable (the readiness gate keeps exactly today's
 *      inputs: backend readiness + a healthy managed server);
 *   3. the optional `sttModel` step is rendered in a separate OPTIONAL group and is
 *      EXCLUDED from the wizard's `installed/total` summary.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  useCompanion,
  VOICE_ENABLED_SETTING_KEY,
} from '@/shared/contexts/CompanionContext';
import { CompanionSettingsPanel } from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  CompanionReadiness,
  LlamaServerStatus,
  ModelFileId,
  ModelFileStatus,
  ModelFileState,
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

    expect(screen.getByText('Dictate with Ctrl+Space')).toBeInTheDocument();
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
