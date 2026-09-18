/**
 * CompanionSettingsPanel — #2892 ST-6: the send-during-reply disposition and the
 * reply hold-open grace controls in the existing "Behavior" group.
 *
 * Pins (REQ-9 / REQ-10 / REQ-12):
 *   1. both QA-bound testids + ids render in the ready branch with the exact copy;
 *   2. the disposition select commits AND persists the chosen value immediately
 *      (no Save step) under `Fredo_companion_send_during_reply`;
 *   3. the grace field displays SECONDS and persists integer MILLISECONDS only on
 *      blur / Enter / stepper — never per keystroke;
 *   4. an out-of-range draft is marked invalid and the clamp heals on commit;
 *   5. ONE shared, visually-hidden polite region announces each commit and clears
 *      it after 2500 ms;
 *   6. the controls are token-native (chakra.select, never NativeSelect; CSS vars,
 *      zero hex/rgba and zero `var(--x)NN` alpha-appends).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  COMPANION_SEND_DURING_REPLY_KEY,
  REPLY_LEAVE_GRACE_SETTING_KEY,
} from '@/shared/contexts/CompanionContext';
import { CompanionSettingsPanel } from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { CompanionReadiness } from '@/shared/components/companion/companionReadiness';

const bothInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    {
      id: 'llamaServer',
      state: 'installed',
      detail: 'llama-server found.',
      resolvedPath: 'C:\\llama-server.exe',
    },
    {
      id: 'modelFiles',
      state: 'installed',
      detail: 'All required model files present.',
      resolvedPath: 'C:\\models',
    },
  ],
};

function renderReady() {
  adapterBridge.setInvoke(async (command: string) => {
    if (command === 'check_companion_readiness') return bothInstalled;
    return undefined;
  });
  return renderWithChakra(
    <CompanionProvider>
      <CompanionSettingsPanel />
    </CompanionProvider>,
  );
}

function graceInput(): HTMLInputElement {
  return document.getElementById('companion-reply-leave-grace') as HTMLInputElement;
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

describe('CompanionSettingsPanel — send-during-reply + grace controls (#2892 ST-6)', () => {
  it('renders both QA-bound controls with their ids, copy and defaults', async () => {
    renderReady();
    await screen.findByTestId('companion-controls');

    // ── Disposition select ─────────────────────────────────────────────────────
    const select = screen.getByTestId('companion-send-during-reply') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.id).toBe('companion-send-during-reply');
    expect(select).toHaveAttribute('aria-label', 'Sending while Fredo is replying');
    expect(select).toHaveAttribute('aria-describedby', 'companion-send-during-reply-help');
    expect(select.value).toBe('queue');
    expect(
      within(select).getByRole('option', { name: 'Queue until Fredo finishes' }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole('option', { name: 'Interrupt and send now' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Choose what happens when you send a message before Fredo finishes the last one.',
      ),
    ).toBeInTheDocument();

    // ── Grace number input (field in SECONDS) ──────────────────────────────────
    const root = screen.getByTestId('companion-reply-leave-grace');
    const input = graceInput();
    expect(root).toContainElement(input);
    expect(input).toHaveAttribute(
      'aria-label',
      'Keep replies open after the pointer leaves (seconds)',
    );
    expect(input).toHaveAttribute('aria-describedby', 'companion-reply-leave-grace-help');
    // Default 2000 ms displays as 2 seconds.
    expect(input.value).toBe('2');
    expect(
      screen.getByText(
        'Fredo keeps a finished reply on screen for this long after your pointer leaves it.',
      ),
    ).toBeInTheDocument();

    // ── Shared polite announcer (visually hidden, empty until a commit) ─────────
    const announcer = screen.getByTestId('companion-settings-commit-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer).toHaveAttribute('aria-atomic', 'true');
    expect(announcer).toHaveTextContent('');
  });

  it('commits + persists the disposition immediately and announces the option label', async () => {
    renderReady();
    await screen.findByTestId('companion-controls');

    const select = screen.getByTestId('companion-send-during-reply') as HTMLSelectElement;
    const announcer = screen.getByTestId('companion-settings-commit-announcer');
    expect(localStorage.getItem(COMPANION_SEND_DURING_REPLY_KEY)).toBeNull();

    fireEvent.change(select, { target: { value: 'interrupt' } });

    await waitFor(() => {
      expect(localStorage.getItem(COMPANION_SEND_DURING_REPLY_KEY)).toBe('interrupt');
    });
    expect(select.value).toBe('interrupt');
    expect(announcer).toHaveTextContent(
      'Sending while Fredo is replying set to Interrupt and send now',
    );

    fireEvent.change(select, { target: { value: 'queue' } });

    await waitFor(() => {
      expect(localStorage.getItem(COMPANION_SEND_DURING_REPLY_KEY)).toBe('queue');
    });
    expect(announcer).toHaveTextContent(
      'Sending while Fredo is replying set to Queue until Fredo finishes',
    );
  });

  it('shows seconds and commits integer ms on blur — never per keystroke', async () => {
    const user = userEvent.setup();
    renderReady();
    await screen.findByTestId('companion-controls');

    const input = graceInput();
    const announcer = screen.getByTestId('companion-settings-commit-announcer');

    await user.clear(input);
    await user.type(input, '5');
    // Draft only: nothing is persisted while typing.
    expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBeNull();
    expect(announcer).toHaveTextContent('');

    await user.tab();

    await waitFor(() => {
      expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBe('5000');
    });
    expect(announcer).toHaveTextContent('Reply hold-open grace set to 5 s');
  });

  it('commits on Enter as well (1.5 s → 1500 ms)', async () => {
    const user = userEvent.setup();
    renderReady();
    await screen.findByTestId('companion-controls');

    const input = graceInput();
    const announcer = screen.getByTestId('companion-settings-commit-announcer');

    await user.clear(input);
    await user.type(input, '1.5');
    expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBeNull();

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBe('1500');
    });
    expect(announcer).toHaveTextContent('Reply hold-open grace set to 1.5 s');
  });

  it('commits the current stepper value (never a per-keystroke write)', async () => {
    const user = userEvent.setup();
    renderReady();
    await screen.findByTestId('companion-controls');

    const root = screen.getByTestId('companion-reply-leave-grace');
    const input = graceInput();

    await user.clear(input);
    await user.type(input, '10');
    expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBeNull();

    // The increment stepper bumps the draft to 10.25 s; the Control's own onClick
    // then commits the stepped draft — never a per-keystroke write.
    await user.click(within(root).getByRole('button', { name: /increment/i }));

    await waitFor(() => {
      expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBe('10250');
    });
    expect(screen.getByTestId('companion-settings-commit-announcer')).toHaveTextContent(
      'Reply hold-open grace set to 10.25 s',
    );
  });

  it('marks an out-of-range draft invalid and the clamp heals it on commit', async () => {
    const user = userEvent.setup();
    renderReady();
    await screen.findByTestId('companion-controls');

    const input = graceInput();
    const help = document.getElementById('companion-reply-leave-grace-help') as HTMLElement;

    await user.clear(input);
    await user.type(input, '90');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(help).toHaveTextContent('Enter 0–60 s');

    fireEvent.blur(input);

    await waitFor(() => {
      expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBe('60000');
    });
    // The clamp healed the persisted value, and the re-synced draft (60 s) clears
    // the invalid treatment + announces the value that was actually stored.
    await waitFor(() => {
      expect(graceInput()).toHaveAttribute('aria-invalid', 'false');
    });
    expect(screen.getByTestId('companion-settings-commit-announcer')).toHaveTextContent(
      'Reply hold-open grace set to 60 s',
    );
  });

  // ── #2892 round-2 defect pins ─────────────────────────────────────────────
  // The displayed input MUST be clamped by the commit, not just the persisted
  // setting: the NumberInput's machine resolves its input element by id, so an
  // out-of-range draft used to stay on screen while the persisted value healed.

  it('P1: clamps an out-of-range draft on Enter and heals the displayed value (#2892 defect)', async () => {
    const user = userEvent.setup();
    renderReady();
    await screen.findByTestId('companion-controls');

    const input = graceInput();
    const help = document.getElementById('companion-reply-leave-grace-help') as HTMLElement;
    const announcer = screen.getByTestId('companion-settings-commit-announcer');

    await user.clear(input);
    await user.type(input, '999999');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(help).toHaveTextContent('Enter 0–60 s');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBe('60000');
    });
    await waitFor(() => {
      expect(input.value).toBe('60');
    });
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(help).toHaveTextContent(
      'Fredo keeps a finished reply on screen for this long after your pointer leaves it.',
    );
    expect(announcer).toHaveTextContent('Reply hold-open grace set to 60 s');
  });

  it('P2: a no-op clamp still normalizes the displayed draft (#2892 defect)', async () => {
    localStorage.setItem(REPLY_LEAVE_GRACE_SETTING_KEY, '60000');
    const user = userEvent.setup();
    renderReady();
    await screen.findByTestId('companion-controls');

    const input = graceInput();
    // Wait for the async persisted value (60 s) to load before editing.
    await waitFor(() => {
      expect(input.value).toBe('60');
    });

    await user.clear(input);
    await user.type(input, '999999');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(input.value).toBe('60');
    });
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBe('60000');
  });

  it('P3: clamps a negative draft to the minimum on Enter (#2892 defect)', async () => {
    const user = userEvent.setup();
    renderReady();
    await screen.findByTestId('companion-controls');

    const input = graceInput();
    const help = document.getElementById('companion-reply-leave-grace-help') as HTMLElement;

    await user.clear(input);
    await user.type(input, '-5');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(help).toHaveTextContent('Enter 0–60 s');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(localStorage.getItem(REPLY_LEAVE_GRACE_SETTING_KEY)).toBe('0');
    });
    await waitFor(() => {
      expect(input.value).toBe('0');
    });
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('clears the shared announcement after 2500 ms', async () => {
    renderReady();
    await screen.findByTestId('companion-controls');

    const select = screen.getByTestId('companion-send-during-reply') as HTMLSelectElement;
    const announcer = screen.getByTestId('companion-settings-commit-announcer');

    fireEvent.change(select, { target: { value: 'interrupt' } });
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Interrupt and send now');
    });

    await act(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2600));
    });

    expect(announcer).toHaveTextContent('');
  }, 8000);

  it('is token-native: chakra.select (never NativeSelect), CSS vars, no hex/rgba/alpha-append', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/components/companion/CompanionSettingsPanel.tsx'),
      'utf8',
    );
    expect(source).toContain('chakra.select');
    expect(source).not.toContain('NativeSelect');
    expect(source).toContain('var(--card-bg)');
    expect(source).toContain('var(--accent-primary)');
    expect(source).toContain('var(--status-error)');
    // No hardcoded colors and no invalid `var(--x)NN` alpha-append. `#2892`-style
    // issue refs in comments are exempt (a 4+-digit all-numeric ref is not a color).
    expect(source).not.toMatch(/#(?![0-9]{4}\b)[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).not.toMatch(/hsla?\(/);
    expect(source).not.toMatch(/var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/);
  });
});
