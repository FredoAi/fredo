/**
 * #2934 ST-3 — Settings → Terminal (default CLI + working directory).
 *
 * The panel registers its save function via `useSettingsSave`; the test harness
 * renders the real `SettingsSaveProvider` and a footer button that calls the
 * registered save, so both keys are proven to persist on the ONE unified Save.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { SettingsSaveProvider, useSettingsSaveContext } from '../../../settings/SettingsSaveContext';
import { TerminalSettings } from '../TerminalSettings';

let settings: Record<string, string> = {};
const saved: Array<{ key: string; value: string }> = [];

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === 'get_setting') return settings[String(args?.key)] ?? null;
  if (command === 'save_setting') {
    saved.push({ key: String(args?.key), value: String(args?.value) });
    return undefined;
  }
  return undefined;
});

const Harness: React.FC = () => {
  const { saveFn } = useSettingsSaveContext();
  return (
    <>
      <TerminalSettings />
      <button type="button" onClick={() => void saveFn?.()}>
        save
      </button>
    </>
  );
};

function renderSettings() {
  return renderWithChakra(
    <SettingsSaveProvider>
      <Harness />
    </SettingsSaveProvider>,
  );
}

beforeEach(() => {
  settings = {};
  saved.length = 0;
  localStorage.clear();
  adapterBridge.setInvoke(invoke as never);
  adapterBridge.setListen((async () => () => {}) as never);
});

afterEach(() => {
  cleanup();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
  vi.clearAllMocks();
  localStorage.clear();
});

describe('#2934 ST-3 — TerminalSettings', () => {
  it('loads the working directory and the default CLI, then saves both on the unified Save', async () => {
    settings = { terminal_work_dir: 'C:\\repo', terminal_default_cli: 'copilot' };
    renderSettings();

    const input = screen.getByPlaceholderText('C:\\Users\\you\\my-repo') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('C:\\repo'));

    const copilotRadio = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="copilot"]',
    );
    await waitFor(() => expect(copilotRadio).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(saved).toEqual([
        { key: 'terminal_work_dir', value: 'C:\\repo' },
        { key: 'terminal_default_cli', value: 'copilot' },
      ]),
    );
  });

  it('defaults to OpenCode when no default CLI has been chosen', async () => {
    renderSettings();
    const opencodeRadio = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="opencode"]',
    );
    await waitFor(() => expect(opencodeRadio).toHaveAttribute('aria-checked', 'true'));
  });

  it('persists a changed default CLI', async () => {
    settings = { terminal_default_cli: 'opencode' };
    renderSettings();

    // Wait for the async load to settle before changing anything.
    const opencodeRadio = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="opencode"]',
    )!;
    await waitFor(() => expect(opencodeRadio).toHaveAttribute('aria-checked', 'true'));

    const copilotRadio = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="copilot"]',
    )!;
    // Click the label (the item) — jsdom forwards label clicks to the control.
    fireEvent.click(copilotRadio.closest('label') ?? copilotRadio);
    await waitFor(() => expect(copilotRadio).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(saved).toContainEqual({ key: 'terminal_default_cli', value: 'copilot' }),
    );
  });

  it('has no duplicate in-panel heading and no legacy CLI copy', async () => {
    renderSettings();
    await screen.findByText('Default CLI');
    expect(screen.queryByText(/run[\s-]?cli/i)).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/run[\s-]?cli/i);
  });
});
