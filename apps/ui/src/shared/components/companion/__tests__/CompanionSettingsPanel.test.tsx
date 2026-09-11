/**
 * Companion settings readiness gate + setup wizard (Spec #2855).
 *
 * Proves the observable contract without a Tauri host:
 *   1. fail-closed — a dev/absent host (`invoke → undefined`) renders ONLY the
 *      wizard, in the `error` state for each prerequisite, and NEVER the normal
 *      controls (no fabricated `installed`);
 *   2. partial readiness — one prerequisite installed / one missing keeps the
 *      wizard and never reads "complete"/renders controls;
 *   3. the install action invokes `install_llama_cpp`, then the re-probe flips
 *      both prerequisites to `installed` and the normal controls replace the
 *      wizard (AC-3/AC-4) — no reload;
 *   4. both prerequisites installed on first probe renders the normal controls
 *      and no wizard.
 *
 * The backend is the source of truth — the test drives `adapterBridge.invoke`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider } from '@/shared/contexts/CompanionContext';
import { CompanionSettingsPanel } from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  CompanionReadiness,
  LlamaCppInstallResult,
} from '@/shared/components/companion/companionReadiness';

const notReady: CompanionReadiness = {
  ready: false,
  prerequisites: [
    { id: 'llamaServer', state: 'missing', detail: 'llama-server not found.', resolvedPath: null },
    { id: 'modelFiles', state: 'missing', detail: '0 of 2 model files present.', resolvedPath: null },
  ],
};

const llamaOnly: CompanionReadiness = {
  ready: false,
  prerequisites: [
    { id: 'llamaServer', state: 'installed', detail: 'llama-server found.', resolvedPath: 'C:\\llama-server.exe' },
    { id: 'modelFiles', state: 'missing', detail: '0 of 2 model files present.', resolvedPath: null },
  ],
};

const bothInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    { id: 'llamaServer', state: 'installed', detail: 'llama-server found.', resolvedPath: 'C:\\llama-server.exe' },
    { id: 'modelFiles', state: 'installed', detail: 'All required model files present.', resolvedPath: 'C:\\models' },
  ],
};

function renderPanel() {
  return renderWithChakra(
    <CompanionProvider>
      <CompanionSettingsPanel />
    </CompanionProvider>,
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

describe('CompanionSettingsPanel readiness gate (#2855)', () => {
  it('fails closed when invoke is unavailable: wizard only, every step error, no controls', async () => {
    adapterBridge.setInvoke(async () => undefined);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    });

    // Wizard present, normal controls ABSENT (AC-1).
    expect(screen.queryByTestId('companion-controls')).toBeNull();
    expect(screen.queryByText('Show Fredo Companion')).toBeNull();

    // Both prerequisites are reported independently and honestly.
    expect(screen.getByTestId('companion-step-llama-server')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-model-files')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute('data-state', 'error');
    });
    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute('data-state', 'error');
  });

  it('partial readiness keeps the wizard and never reads complete', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return llamaOnly;
      return undefined;
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-summary')).toHaveTextContent(
        '1 of 2 prerequisites ready',
      );
    });
    expect(screen.queryByTestId('companion-controls')).toBeNull();
    expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute('data-state', 'installed');
    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute('data-state', 'missing');
    expect(screen.getByTestId('companion-setup-summary')).not.toHaveTextContent('complete');
  });

  it('installs llama.cpp then swaps to the normal controls after the in-session re-check', async () => {
    let current: CompanionReadiness = notReady;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'check_companion_readiness') return current;
      if (command === 'install_llama_cpp') {
        current = bothInstalled;
        const result: LlamaCppInstallResult = {
          success: true,
          output: 'Successfully installed',
          error: null,
          code: null,
        };
        return result;
      }
      return undefined;
    });
    adapterBridge.setInvoke(invoke);

    renderPanel();

    const installButton = await screen.findByTestId('companion-step-llama-server-install');
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(screen.getByTestId('companion-controls')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('companion-setup-wizard')).toBeNull();
    expect(screen.getByText('Show Fredo Companion')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('install_llama_cpp', undefined);
  });

  it('shows an actionable error and stays not-set-up when the install fails', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return notReady;
      if (command === 'install_llama_cpp') {
        const result: LlamaCppInstallResult = {
          success: false,
          output: '',
          error: "Couldn't install llama.cpp — winget isn't available. Choose Re-check.",
          code: 'wingetUnavailable',
        };
        return result;
      }
      return undefined;
    });

    renderPanel();

    fireEvent.click(await screen.findByTestId('companion-step-llama-server-install'));

    await waitFor(() => {
      expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute('data-state', 'error');
    });
    expect(screen.getByTestId('companion-step-llama-server')).toHaveTextContent("winget isn't available");
    expect(screen.queryByTestId('companion-controls')).toBeNull();
    expect(screen.getByTestId('companion-step-llama-server-retry')).toBeInTheDocument();
    // The pane never reports completion on failure.
    expect(screen.getByTestId('companion-setup-summary')).not.toHaveTextContent('complete');
  });

  it('renders the normal controls directly when both prerequisites are already installed', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
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
