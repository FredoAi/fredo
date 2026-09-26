/**
 * Spec 2942 ST-4 — Settings → Terminal (default session TYPE + working directory).
 *
 * The control now offers THREE choices — Terminal (plain shell), OpenCode, and
 * GitHub Copilot — reusing the `terminal_default_cli` key with a widened value
 * domain (NO new key, NO migration). The panel registers its save function via
 * `useSettingsSave`; the harness renders the real `SettingsSaveProvider` and a
 * footer button that calls the registered save, so the unified Save is proven to
 * persist both keys.
 *
 * R-4.3: changing a default writes ONLY the two settings keys — it never mutates
 * a live session or a persisted record.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { SettingsSaveProvider, useSettingsSaveContext } from '../../../settings/SettingsSaveContext';
import { TerminalSettings } from '../TerminalSettings';
import type { TerminalSessionInfo } from '../../sessionModel';
import {
  getTerminalPresentation,
  resetTerminalPresentationStoreForTests,
} from '../../presentation';

let settings: Record<string, string> = {};
const saved: Array<{ key: string; value: string }> = [];
const commands: string[] = [];
/** Live PTY sessions the backend session list reports (the live-host probe). */
let liveSessions: TerminalSessionInfo[] = [];

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  commands.push(command);
  if (command === 'get_setting') return settings[String(args?.key)] ?? null;
  if (command === 'save_setting') {
    saved.push({ key: String(args?.key), value: String(args?.value) });
    return undefined;
  }
  if (command === 'list_terminal_sessions') return liveSessions;
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
  liveSessions = [];
  // The presentation store is module-scoped; wipe it so one test's mode choice
  // cannot leak into the next.
  resetTerminalPresentationStoreForTests();
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

function liveSession(overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    id: 'live-1',
    cli: 'opencode',
    status: 'running',
    error: null,
    errorKind: null,
    workDir: 'C:\\Code\\fredo',
    cols: 80,
    rows: 24,
    pid: 4242,
    startedAt: 1,
    ...overrides,
  };
}

describe('Spec #2947 ST-6 — TerminalSettings (presentation mode + mode-change teardown)', () => {
  it('renders the discoverable "Presentation" radio with both wire options, defaulting to Separate window (R-1.1/R-4.1)', async () => {
    renderSettings();

    const group = await screen.findByTestId('terminal-presentation-mode');
    expect(group).toBeTruthy();
    expect(screen.getByText('Presentation')).toBeTruthy();
    expect(screen.getByText('Where Terminal opens when you launch it.')).toBeTruthy();
    expect(screen.getByText('Same window')).toBeTruthy();
    expect(screen.getByText('Separate window')).toBeTruthy();

    await waitFor(() => expect(radio('new-window')).toHaveAttribute('aria-checked', 'true'));
    expect(radio('same-window')).toHaveAttribute('aria-checked', 'false');
    // The wire value is NOT the label; the DOM hooks carry the wire value.
    expect(radio('same-window')).toHaveAttribute(
      'data-testid',
      'terminal-presentation-mode-same-window',
    );
    expect(radio('new-window')).toHaveAttribute(
      'data-testid',
      'terminal-presentation-mode-new-window',
    );
  });

  it('hydrates the persisted mode from terminal_presentation_mode (R-1.2)', async () => {
    settings = { terminal_presentation_mode: 'same-window' };
    renderSettings();

    await screen.findByTestId('terminal-presentation-mode');
    await waitFor(() => expect(radio('same-window')).toHaveAttribute('aria-checked', 'true'));
    expect(radio('new-window')).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the switch hint and persists the mode on Save with no live host — no dialog, no teardown (R-1.1)', async () => {
    renderSettings();
    await screen.findByTestId('terminal-presentation-mode');

    choose('same-window');
    await waitFor(() => expect(radio('same-window')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('terminal-presentation-mode-hint')).toHaveTextContent(
      'Takes effect the next time Terminal opens.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(saved).toContainEqual({
        key: 'terminal_presentation_mode',
        value: 'same-window',
      }),
    );
    expect(getTerminalPresentation()).toBe('same-window');
    expect(commands).not.toContain('close_terminal_window');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms before ending a live host; cancelling mutates nothing (R-5.3)', async () => {
    liveSessions = [liveSession()];
    renderSettings();
    await screen.findByTestId('terminal-presentation-mode');
    choose('same-window');
    await waitFor(() => expect(radio('same-window')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(
      await screen.findByRole('dialog', { name: 'Change presentation mode?' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('terminal-presentation-mode-cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getTerminalPresentation()).toBe('new-window');
    expect(saved.some((s) => s.key === 'terminal_presentation_mode')).toBe(false);
    expect(commands).not.toContain('close_terminal_window');
  });

  it('confirming persists the mode and tears the superseded host down via the shipped close_terminal_window (R-5.1)', async () => {
    liveSessions = [liveSession()];
    renderSettings();
    await screen.findByTestId('terminal-presentation-mode');
    choose('same-window');
    await waitFor(() => expect(radio('same-window')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await screen.findByRole('dialog', { name: 'Change presentation mode?' });
    fireEvent.click(screen.getByTestId('terminal-presentation-mode-confirm'));

    await waitFor(() =>
      expect(saved).toContainEqual({
        key: 'terminal_presentation_mode',
        value: 'same-window',
      }),
    );
    expect(getTerminalPresentation()).toBe('same-window');
    await waitFor(() => expect(commands).toContain('close_terminal_window'));
  });
});
