/**
 * Spec 2942 ST-4 — Settings → Terminal (default session TYPE + working directory).
 *
 * The control offers THREE choices — Terminal (plain shell), OpenCode, and
 * GitHub Copilot — reusing the `terminal_default_cli` key with a widened value
 * domain (NO new key, NO migration). The panel registers its save function via
 * `useSettingsSave`; the harness renders the real `SettingsSaveProvider` and a
 * footer button that calls the registered save, so the unified Save is proven to
 * persist both keys.
 *
 * R-4.3: changing a default writes ONLY the two settings keys — it never mutates
 * a live session or a persisted record.
 *
 * Spec #2955 ST-3 — the Terminal-only presentation control is SUBSUMED by the
 * platform-wide Settings → Apps section. The superseded Presentation block and
 * its confirm dialog are GONE; Terminal is now one row in the Apps section
 * (covered by `AppPresentationSettings.test.tsx`). This file asserts the
 * subsumption: no competing presentation control remains here.
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
const commands: string[] = [];

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  commands.push(command);
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

function radio(value: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
}

/** Click a radio's owning label — jsdom forwards label clicks to the control. */
function choose(value: string) {
  const input = radio(value);
  if (!input) throw new Error(`no radio for ${value}`);
  fireEvent.click(input.closest('label') ?? input);
}

beforeEach(() => {
  settings = {};
  saved.length = 0;
  commands.length = 0;
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

describe('Spec 2942 ST-4 — TerminalSettings (default session type)', () => {
  it('renders exactly three session-type choices: Terminal, OpenCode, GitHub Copilot', async () => {
    renderSettings();
    await screen.findByText('Default session type');

    await waitFor(() => expect(radio('shell')).toBeTruthy());
    expect(radio('opencode')).toBeTruthy();
    expect(radio('copilot')).toBeTruthy();

    // The labels are the user-facing type names (Terminal = plain shell).
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('GitHub Copilot')).toBeTruthy();

    // The QA hook is present for every value (Spec 2942 §10).
    for (const value of ['shell', 'opencode', 'copilot']) {
      expect(
        document.querySelector(`[data-testid="terminal-default-type-${value}"]`),
      ).toBeTruthy();
    }
  });

  it('defaults to Terminal (plain shell) when no default type has been chosen', async () => {
    renderSettings();
    await waitFor(() => expect(radio('shell')).toHaveAttribute('aria-checked', 'true'));
    expect(radio('opencode')).toHaveAttribute('aria-checked', 'false');
    expect(radio('copilot')).toHaveAttribute('aria-checked', 'false');
  });

  it('falls back to Terminal for a corrupt stored value', async () => {
    settings = { terminal_default_cli: 'not-a-kind' };
    renderSettings();
    await waitFor(() => expect(radio('shell')).toHaveAttribute('aria-checked', 'true'));
  });

  it('resolves a legacy stored value (copilot) — the key is reused, not migrated', async () => {
    settings = { terminal_default_cli: 'copilot' };
    renderSettings();
    await waitFor(() => expect(radio('copilot')).toHaveAttribute('aria-checked', 'true'));
  });

  it('loads the working directory + default type, then saves both on the unified Save', async () => {
    settings = { terminal_work_dir: 'C:\\repo', terminal_default_cli: 'copilot' };
    renderSettings();

    const input = screen.getByPlaceholderText('C:\\Users\\you\\my-repo') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('C:\\repo'));
    await waitFor(() => expect(radio('copilot')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(saved).toEqual([
        { key: 'terminal_work_dir', value: 'C:\\repo' },
        { key: 'terminal_default_cli', value: 'copilot' },
      ]),
    );
  });

  it('persists a changed default type (round-trip: Terminal → GitHub Copilot)', async () => {
    settings = { terminal_default_cli: 'shell' };
    renderSettings();

    await waitFor(() => expect(radio('shell')).toHaveAttribute('aria-checked', 'true'));

    choose('copilot');
    await waitFor(() => expect(radio('copilot')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(saved).toContainEqual({ key: 'terminal_default_cli', value: 'copilot' }),
    );
  });

  it('changing the default mutates no existing session or record (R-4.3)', async () => {
    settings = { terminal_work_dir: 'C:\\repo', terminal_default_cli: 'opencode' };
    renderSettings();
    await waitFor(() => expect(radio('opencode')).toHaveAttribute('aria-checked', 'true'));

    choose('shell');
    await waitFor(() => expect(radio('shell')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(saved).toContainEqual({ key: 'terminal_default_cli', value: 'shell' }),
    );

    // The panel issues settings reads/writes ONLY — never a session/record
    // mutation command (no spawn/close/resume/delete).
    expect(commands.filter((c) => c !== 'get_setting' && c !== 'save_setting')).toEqual([]);
    expect(
      saved.every((s) => s.key === 'terminal_work_dir' || s.key === 'terminal_default_cli'),
    ).toBe(true);
  });

  it('has no duplicate in-panel heading and no legacy CLI copy', async () => {
    renderSettings();
    await screen.findByText('Default session type');
    expect(screen.queryByText(/run[\s-]?cli/i)).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/run[\s-]?cli/i);
  });
});

describe('Spec #2955 ST-3 — Terminal presentation control is subsumed (not duplicated)', () => {
  it('no longer renders any Terminal presentation control — the Apps section is the ONE place', async () => {
    renderSettings();
    await screen.findByText('Default session type');

    // The superseded #2947 control is gone: no group, no wire radios, no hint.
    expect(screen.queryByTestId('terminal-presentation-mode')).toBeNull();
    expect(screen.queryByTestId('terminal-presentation-mode-loading')).toBeNull();
    expect(screen.queryByTestId('terminal-presentation-mode-hint')).toBeNull();
    expect(document.querySelector('input[value="same-window"]')).toBeNull();
    expect(document.querySelector('input[value="new-window"]')).toBeNull();

    // No "Presentation" heading / old option labels remain in this panel.
    expect(screen.queryByText('Presentation')).toBeNull();
    expect(screen.queryByText('Same window')).toBeNull();
    expect(screen.queryByText('Separate window')).toBeNull();
  });

  it('no longer owns the confirm-before-ending-sessions dialog', async () => {
    renderSettings();
    await screen.findByText('Default session type');

    expect(screen.queryByTestId('terminal-presentation-mode-confirm')).toBeNull();
    expect(screen.queryByTestId('terminal-presentation-mode-cancel')).toBeNull();
    expect(screen.queryByTestId('app-presentation-change-confirm')).toBeNull();
    expect(screen.queryByTestId('app-presentation-change-cancel')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the other Terminal fields (default type + working directory) intact', async () => {
    renderSettings();
    await screen.findByText('Default session type');

    expect(screen.getByText('Default session type')).toBeTruthy();
    expect(screen.getByText('Working directory')).toBeTruthy();
    expect(radio('shell')).toBeTruthy();
    expect(screen.getByPlaceholderText('C:\\Users\\you\\my-repo')).toBeTruthy();
  });
});
