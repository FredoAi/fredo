/**
 * Companion settings readiness gate + setup wizard (Spec #2855; one prerequisite
 * since #3141 ST-6).
 *
 * Proves the observable contract without a Tauri host:
 *   1. fail-closed — a dev/absent host (`invoke → undefined`) renders the wizard
 *      in the `error` state for each step, and NEVER the normal controls (no
 *      fabricated `installed`);
 *   2. the model files are the ONLY provisioning prerequisite — no
 *      `companion-step-llama-server` row, no install affordance, and the summary
 *      banner carries the one-prerequisite story instead of an `n of m` count;
 *   3. an in-session re-check flips readiness and the normal controls replace the
 *      wizard (AC-3/AC-4) — no reload;
 *   4. once the model files are installed the normal controls render (the ready
 *      gate still requires a healthy engine).
 *
 * The backend is the source of truth — the test drives `adapterBridge.invoke`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion, WELCOME_TEXT } from '@/shared/contexts/CompanionContext';
import { CompanionSettingsPanel } from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  CompanionReadiness,
  LlamaServerStatus,
} from '@/shared/components/companion/companionReadiness';

const notReady: CompanionReadiness = {
  ready: false,
  prerequisites: [
    { id: 'modelFiles', state: 'missing', detail: '0 of 3 model files present.', resolvedPath: null },
  ],
};

/** One backend prerequisite installed but no engine yet — the wizard stays. */
const modelFilesOnly: CompanionReadiness = {
  ready: true,
  prerequisites: [
    { id: 'modelFiles', state: 'installed', detail: 'All required model files present.', resolvedPath: 'C:\\models' },
  ],
};

const bothInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    { id: 'modelFiles', state: 'installed', detail: 'All required model files present.', resolvedPath: 'C:\\models' },
  ],
};

function status(overrides: Partial<LlamaServerStatus> = {}): LlamaServerStatus {
  return {
    running: false,
    healthy: false,
    port: null,
    pid: null,
    configPath: '',
    logPath: '',
    lastError: null,
    backendMode: 'auto',
    devices: [],
    ...overrides,
  };
}

function renderPanel() {
  return renderWithChakra(
    <CompanionProvider>
      <CompanionSettingsPanel />
    </CompanionProvider>,
  );
}

/**
 * #2870 ST-1: observable companion context surface used by the turn-on test —
 * the real settings Switch is the user control that drives `setVisible(true)`.
 */
function CompanionStateProbe() {
  const { state } = useCompanion();
  return (
    <div
      data-testid="companion-state-probe"
      data-visible={String(state.isVisible)}
      data-away={String(state.isAway)}
      data-message={state.message ?? ''}
    />
  );
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
});

describe('CompanionSettingsPanel readiness gate (#2855 / #3141)', () => {
  it('fails closed when invoke is unavailable: wizard only, step error, no controls', async () => {
    adapterBridge.setInvoke(async () => undefined);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    });

    // Wizard present, normal controls ABSENT (AC-1).
    expect(screen.queryByTestId('companion-controls')).toBeNull();
    expect(screen.queryByText('Show Fredo Companion')).toBeNull();

    // The ONLY backend prerequisite is the model files (#3141) — the retired
    // llama.cpp install row must not exist anywhere.
    expect(screen.getByTestId('companion-step-model-files')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-step-llama-server')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute('data-state', 'error');
    });
    // No install affordance survives.
    expect(screen.queryByText('Install llama.cpp')).toBeNull();
  });

  it('shows the one-prerequisite banner (no `n of m` fraction) while the engine is not running', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return modelFilesOnly;
      if (command === 'get_llama_server_status') return status();
      return undefined;
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-summary')).toHaveTextContent(
        'Model files ready — nothing else to install',
      );
    });
    // The retired fraction is GONE (both the copy and the `1/1` counter).
    expect(screen.getByTestId('companion-setup-summary')).not.toHaveTextContent('1 of 1');
    expect(screen.getByTestId('companion-setup-summary')).not.toHaveTextContent('prerequisites');

    expect(screen.queryByTestId('companion-controls')).toBeNull();
    // ModelFilesStepCard's own state vocabulary (`complete` once all 3 are present).
    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute('data-state', 'complete');
    // AC-25 recovery path: the backend control IS present below the wizard.
    expect(screen.getByTestId('companion-backend-mode')).toBeInTheDocument();
  });

  it('omits the backend control while the model files are missing (one decision: download)', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return notReady;
      if (command === 'get_llama_server_status') return status();
      return undefined;
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-summary')).toHaveTextContent(
        'Model files needed before the companion can run',
      );
    });
    expect(screen.queryByTestId('companion-backend-mode')).toBeNull();
    expect(screen.queryByTestId('companion-controls')).toBeNull();
  });

  it('swaps to the normal controls after the in-session re-check (no reload)', async () => {
    let current: CompanionReadiness = notReady;
    let currentStatus = status();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'check_companion_readiness') return current;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'download_model') {
        current = bothInstalled;
        currentStatus = status({ running: true, healthy: true, backend: 'cpu' });
        return { success: true, files: [], output: 'done' };
      }
      return undefined;
    });
    adapterBridge.setInvoke(invoke);

    renderPanel();

    const downloadButton = await screen.findByTestId('companion-step-model-files-download');
    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(screen.getByTestId('companion-controls')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('companion-setup-wizard')).toBeNull();
    expect(screen.getByText('Show Fredo Companion')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('download_model', undefined);
  });

  it('shows an actionable error and stays not-set-up when the download fails', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return notReady;
      if (command === 'get_llama_server_status') return status();
      if (command === 'download_model') {
        return {
          success: false,
          error: 'No space left on device (ENOSPC)',
          files: [],
        };
      }
      return undefined;
    });

    renderPanel();

    fireEvent.click(await screen.findByTestId('companion-step-model-files-download'));

    await waitFor(() => {
      expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute('data-state', 'error');
    });
    expect(screen.getByTestId('companion-step-model-files-status')).toHaveTextContent(
      'Download failed',
    );
    expect(screen.queryByTestId('companion-controls')).toBeNull();
    // Recovery stays available: the download action is still offered.
    expect(screen.getByTestId('companion-step-model-files-download')).toBeInTheDocument();
  });

  it('renders the normal controls directly when the model files and engine are already ready', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') {
        return status({ running: true, healthy: true, backend: 'cpu' });
      }
      return undefined;
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('companion-controls')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('companion-setup-wizard')).toBeNull();
    expect(screen.getByText('Show Fredo Companion')).toBeInTheDocument();
  });
});

// ── #2870 ST-1: the real turn-on control drives the welcome (R-2) ─────────────

describe('CompanionSettingsPanel turn-on → canonical context (#2870 ST-1)', () => {
  it('toggling the real Switch ON fires WELCOME_TEXT and leaves Fredo home', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') {
        return status({ running: true, healthy: true, backend: 'cpu' });
      }
      return undefined;
    });

    renderWithChakra(
      <CompanionProvider>
        <CompanionSettingsPanel />
        <CompanionStateProbe />
      </CompanionProvider>,
    );

    const toggle = await screen.findByLabelText('Show Fredo Companion');
    // Persisted preference starts OFF — no greeting before the user turns it on.
    expect(screen.getByTestId('companion-state-probe').getAttribute('data-message')).toBe('');
    expect(screen.getByTestId('companion-state-probe').getAttribute('data-visible')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId('companion-state-probe').getAttribute('data-message')).toBe(WELCOME_TEXT);
    });
    expect(screen.getByTestId('companion-state-probe').getAttribute('data-visible')).toBe('true');
    expect(screen.getByTestId('companion-state-probe').getAttribute('data-away')).toBe('false');
  });
});
