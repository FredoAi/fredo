/**
 * CompanionSettingsPanel — the AC-24 backend-mode control (Spec #3141 ST-6).
 *
 * Proves, without a Tauri host, every C-1 hook the plan ACCEPTED:
 *   - group root `data-testid="companion-backend-mode"`, a segmented RADIOGROUP
 *     (Chakra v3 `SegmentGroup`, never a `<select>` / `NativeSelect`),
 *     `aria-label="Companion backend"`,
 *     `aria-describedby` → `companion-backend-mode-help`
 *     (+ `companion-backend-mode-error` when the save error line renders);
 *   - item `value`s exactly `auto` / `gpu` / `cpu` and per-segment
 *     `data-testid="companion-backend-mode-{auto,gpu,cpu}"`;
 *   - the group's own polite region `data-testid="companion-backend-announcer"`;
 *   - the readout `data-testid="companion-backend-readout"` with `data-backend`
 *     / `data-mode`;
 *   - a selection persists under `llama_server_backend`; a REJECTED write reverts
 *     the control and renders the error line;
 *   - the control is PRESENT and OPERABLE in the not-ready state when the model
 *     files are installed (AC-25's ONLY recovery path) and ABSENT when they are
 *     missing.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider } from '@/shared/contexts/CompanionContext';
import {
  CompanionSettingsPanel,
  COMPANION_BACKEND_HELP,
  COMPANION_BACKEND_LABEL,
  COMPANION_BACKEND_SAVE_ERROR_COPY,
  companionBackendReadoutValue,
} from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  CompanionReadiness,
  LlamaServerStatus,
} from '@/shared/components/companion/companionReadiness';

const modelFilesInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    { id: 'modelFiles', state: 'installed', detail: 'ok', resolvedPath: 'C:\\models' },
  ],
};

const modelFilesMissing: CompanionReadiness = {
  ready: false,
  prerequisites: [
    { id: 'modelFiles', state: 'missing', detail: 'none', resolvedPath: null },
  ],
};

function status(overrides: Partial<LlamaServerStatus> = {}): LlamaServerStatus {
  return {
    running: true,
    healthy: true,
    port: null,
    pid: null,
    configPath: '',
    logPath: '',
    lastError: null,
    backendMode: 'auto',
    devices: [],
    backend: 'cpu',
    ...overrides,
  };
}

interface RenderOptions {
  readiness?: CompanionReadiness;
  engineStatus?: LlamaServerStatus;
  storedMode?: string | null;
  saveSetting?: (args: unknown) => Promise<unknown>;
}

function renderPanel(options: RenderOptions = {}) {
  const readiness = options.readiness ?? modelFilesInstalled;
  const engineStatus = options.engineStatus ?? status();
  const saveSetting = options.saveSetting ?? (async () => undefined);
  const invoke = vi.fn(async (command: string, args?: unknown) => {
    if (command === 'check_companion_readiness') return readiness;
    if (command === 'get_llama_server_status') return engineStatus;
    if (command === 'get_setting') return options.storedMode ?? null;
    if (command === 'save_setting') return saveSetting(args);
    return undefined;
  });
  adapterBridge.setInvoke(invoke);
  adapterBridge.setListen(async () => () => {});
  const utils = renderWithChakra(
    <CompanionProvider>
      <CompanionSettingsPanel />
    </CompanionProvider>,
  );
  return { ...utils, invoke };
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

describe('#3141 ST-6 — AC-24 backend-mode control hooks (C-1)', () => {
  it('renders a segmented radiogroup with the frozen hooks, copy and item values', async () => {
    renderPanel();

    const group = await screen.findByTestId('companion-backend-mode');
    // A radiogroup — NOT a `<select>`, NOT a NativeSelect.
    expect(group).toHaveAttribute('role', 'radiogroup');
    expect(group.tagName).not.toBe('SELECT');
    expect(screen.queryByTestId('companion-backend-mode')?.querySelector('select')).toBeNull();

    expect(group).toHaveAttribute('aria-label', 'Companion backend');
    expect(group).toHaveAttribute('aria-describedby', 'companion-backend-mode-help');

    // The help text carries the exact accepted copy under the frozen id.
    const help = document.getElementById('companion-backend-mode-help');
    expect(help).not.toBeNull();
    expect(help).toHaveTextContent(COMPANION_BACKEND_HELP);
    expect(COMPANION_BACKEND_HELP).toContain(
      'Changes apply the next time the companion engine starts.',
    );
    expect(COMPANION_BACKEND_LABEL).toBe('Companion backend');

    // Per-segment hooks, each a real radio input with the wire value.
    for (const value of ['auto', 'gpu', 'cpu'] as const) {
      const item = screen.getByTestId(`companion-backend-mode-${value}`);
      expect(item).toBeInTheDocument();
      const radio = within(item).getByRole('radio');
      expect(radio).toHaveAttribute('value', value);
      expect(radio).not.toBeDisabled();
    }

    // Group-level polite live region.
    const announcer = screen.getByTestId('companion-backend-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
  });

  it('renders the readout with data-backend / data-mode from the status probe', async () => {
    renderPanel({
      engineStatus: status({
        backend: 'gpu',
        devices: [
          {
            name: 'CUDA0',
            description: 'NVIDIA GeForce RTX 4070',
            deviceType: 'gpu',
            memoryFreeBytes: 1,
            memoryTotalBytes: 2,
          },
        ],
      }),
      storedMode: 'auto',
    });

    const readout = await screen.findByTestId('companion-backend-readout');
    await waitFor(() => {
      expect(readout).toHaveAttribute('data-backend', 'gpu');
      expect(readout).toHaveAttribute('data-mode', 'auto');
    });
    expect(readout).toHaveTextContent('Running on');
    expect(readout).toHaveTextContent(
      'GPU — NVIDIA GeForce RTX 4070 (CUDA0)',
    );
  });

  it('shows `Not running` (never a fabricated backend) when no engine is loaded', async () => {
    renderPanel({
      engineStatus: status({ running: false, healthy: false, backend: undefined, devices: [] }),
    });

    const readout = await screen.findByTestId('companion-backend-readout');
    await waitFor(() => {
      expect(readout).toHaveAttribute('data-backend', 'none');
    });
    expect(readout).toHaveTextContent('Not running');
    expect(readout).not.toHaveTextContent('GPU');
  });

  it('persists a selection under `llama_server_backend` and announces it politely', async () => {
    const { invoke } = renderPanel({ storedMode: 'auto' });

    const group = await screen.findByTestId('companion-backend-mode');
    await waitFor(() => {
      expect(within(group).getByRole('radio', { name: 'Automatic' })).toBeChecked();
    });

    fireEvent.click(screen.getByTestId('companion-backend-mode-cpu'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('save_setting', {
        key: 'llama_server_backend',
        value: 'cpu',
      });
    });
    expect(screen.getByTestId('companion-backend-announcer')).toHaveTextContent(
      'Companion backend set to CPU. Applies the next time the companion engine starts.',
    );
  });

  it('reverts the selection and renders the described error line when the write is rejected', async () => {
    const { invoke } = renderPanel({
      storedMode: 'auto',
      saveSetting: async () => {
        throw new Error('disk full');
      },
    });

    const group = await screen.findByTestId('companion-backend-mode');
    await waitFor(() => {
      expect(within(group).getByRole('radio', { name: 'Automatic' })).toBeChecked();
    });

    fireEvent.click(screen.getByTestId('companion-backend-mode-gpu'));

    // The save-error line carries the frozen id (the second aria-describedby
    // target); the group's polite region announces the same sentence.
    const errorLine = await waitFor(() => {
      const element = document.getElementById('companion-backend-mode-error');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(errorLine).toHaveTextContent(COMPANION_BACKEND_SAVE_ERROR_COPY);
    // The control reverts to the last persisted value and gains the second
    // aria-describedby target.
    await waitFor(() => {
      expect(within(group).getByRole('radio', { name: 'Automatic' })).toBeChecked();
    });
    expect(group).toHaveAttribute(
      'aria-describedby',
      'companion-backend-mode-help companion-backend-mode-error',
    );
    expect(invoke).toHaveBeenCalledWith('save_setting', {
      key: 'llama_server_backend',
      value: 'gpu',
    });
  });

  it('PRESENT and operable in the not-ready state when the model files are installed', async () => {
    renderPanel({
      readiness: modelFilesInstalled,
      engineStatus: status({
        running: false,
        healthy: false,
        backend: undefined,
        devices: [],
        lastError: 'no usable GPU',
        lastErrorCode: 'gpuUnavailable',
      }),
      storedMode: 'gpu',
    });

    // Not ready (engine failed) ⇒ the wizard is shown…
    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    });
    // …AND the engine group is right there for AC-25's recovery.
    const group = await screen.findByTestId('companion-backend-mode');
    expect(group).not.toBeDisabled();
    expect(group).not.toHaveAttribute('aria-busy');
    fireEvent.click(screen.getByTestId('companion-backend-mode-cpu'));
    await waitFor(() => {
      expect(within(group).getByRole('radio', { name: 'CPU' })).toBeChecked();
    });
  });

  it('ABSENT in the not-ready state when the model files are missing', async () => {
    renderPanel({ readiness: modelFilesMissing });

    await waitFor(() => {
      expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('companion-backend-mode')).toBeNull();
    expect(screen.queryByTestId('companion-backend-readout')).toBeNull();
  });

  it('renders in the READY branch too (one render site, both branches)', async () => {
    renderPanel();
    await screen.findByTestId('companion-controls');
    expect(screen.getByTestId('companion-backend-mode')).toBeInTheDocument();
    expect(screen.getByTestId('companion-backend-readout')).toBeInTheDocument();
  });
});

// ── Pure derivation + token pins ─────────────────────────────────────────────

describe('#3141 ST-6 — backend readout composition + token discipline', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/shared/components/companion/CompanionSettingsPanel.tsx'),
    'utf8',
  );

  it('composes the readout from the ggml word + description + device names', () => {
    expect(companionBackendReadoutValue('cpu', [])).toBe('CPU');
    // A CPU device literally named `CPU` is NOT repeated.
    expect(
      companionBackendReadoutValue('cpu', [
        {
          name: 'CPU',
          description: '',
          deviceType: 'cpu',
          memoryFreeBytes: 0,
          memoryTotalBytes: 0,
        },
      ]),
    ).toBe('CPU');
    expect(
      companionBackendReadoutValue('integratedGpu', [
        {
          name: 'Vulkan0',
          description: 'Intel Iris Xe',
          deviceType: 'integratedGpu',
          memoryFreeBytes: 0,
          memoryTotalBytes: 0,
        },
      ]),
    ).toBe('Integrated GPU — Intel Iris Xe (Vulkan0)');
    expect(companionBackendReadoutValue('accel', [])).toBe('Accelerator');
    expect(companionBackendReadoutValue('meta', [])).toBe('Meta device');
  });

  it('uses SegmentGroup (never a select / NativeSelect) and drives colors from tokens', () => {
    expect(source).toContain('SegmentGroup.Root');
    expect(source).toContain('SegmentGroup.ItemHiddenInput');
    expect(source).not.toMatch(/<NativeSelect|NativeSelect\./);
    // The backend control is NOT a select input (the send-during-reply row keeps
    // `chakra.select`, so the assertion is scoped to the engine group).
    const engineGroup = source.slice(
      source.indexOf('const CompanionEngineGroup'),
      source.indexOf('// ── Idle auto-return control'),
    );
    expect(engineGroup).not.toContain('chakra.select');
    expect(engineGroup).not.toContain('<option');
    // Token discipline: no alpha-append onto a var(), no hardcoded hex/rgba
    // (a `#` only ever appears in prose references such as "Spec #3141" here).
    expect(source).not.toMatch(/var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/);
    expect(source).not.toMatch(/(?:bg|color|borderColor|fill|stroke|outline)=["']#/);
    expect(source).not.toMatch(/bg=["']rgba?\(/);
    expect(source).toContain('tint(');
  });
});
