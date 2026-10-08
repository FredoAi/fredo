/**
 * Spec #2955 ST-3 — Settings → Apps (per-app presentation choice).
 *
 * Pins the section contract: one row per showable app, Main/Own radios, immediate
 * write-through (no Save footer), factory apps listed with a disabled "Own
 * window" + note, and the Terminal-only confirm-before-ending-sessions dialog
 * (moved here from `TerminalSettings.tsx`). The section is rendered inside a
 * `WindowSystemProvider` because it reads `useWindowActions().closeWindow` for
 * the in-window teardown.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { LuAppWindow } from 'react-icons/lu';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowSystemProvider } from '@/shared/window-system/WindowSystemProvider';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { FredoApplicationClass } from '@/shared/classes';
import { getApplications, registerApplication } from '@/applications/applicationRegistry';
import {
  getAppPresentation,
  resetAppPresentationStoreForTests,
} from '@/shared/window-system/appPresentationStore';
import { AppPresentationSettings } from '../AppPresentationSettings';

/** Minimal registered feature stub — only the metadata the section reads. */
class StubFeature extends FredoApplicationClass {
  readonly id: string;
  readonly name: string;
  readonly icon = LuAppWindow;
  readonly showable: boolean;
  readonly isMultiWindow: boolean;

  constructor(
    id: string,
    name: string,
    opts: { showable?: boolean; isMultiWindow?: boolean } = {},
  ) {
    super();
    this.id = id;
    this.name = name;
    this.showable = opts.showable ?? true;
    this.isMultiWindow = opts.isMultiWindow ?? false;
  }

  render() {
    return <div data-testid={`stub-${this.id}`} />;
  }
}

// Registered once at module load (the registry is immutable after startup).
registerApplication(new StubFeature('terminal', 'Terminal'));
registerApplication(new StubFeature('doom', 'Doom'));
registerApplication(new StubFeature('query-viewer', 'Query Viewer', { isMultiWindow: true }));
registerApplication(new StubFeature('hidden-app', 'Hidden App', { showable: false }));

let settings: Record<string, string> = {};
const saved: Array<{ key: string; value: string }> = [];
const commands: string[] = [];
let liveSessions: Array<{ status: string }> = [];

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  commands.push(command);
  // The presentation store now persists/reads the CONTROL plane (B-2/B-3).
  if (command === 'get_control_setting') return settings[String(args?.key)] ?? null;
  if (command === 'save_control_setting') {
    saved.push({ key: String(args?.key), value: String(args?.value) });
    return undefined;
  }
  if (command === 'get_setting') return settings[String(args?.key)] ?? null;
  if (command === 'save_setting') {
    saved.push({ key: String(args?.key), value: String(args?.value) });
    return undefined;
  }
  if (command === 'list_terminal_sessions') return liveSessions;
  if (command === 'close_app_window') return true;
  return undefined;
});

function renderSection() {
  return renderWithChakra(
    <WindowSystemProvider>
      <AppPresentationSettings />
    </WindowSystemProvider>,
  );
}

function radio(appId: string, mode: 'same-window' | 'new-window'): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    `[data-testid="app-presentation-mode-${appId}-${mode}"]`,
  );
}

function choose(appId: string, mode: 'same-window' | 'new-window') {
  const input = radio(appId, mode);
  if (!input) throw new Error(`no radio for ${appId}/${mode}`);
  fireEvent.click(input.closest('label') ?? input);
}

/** The persisted map value written for `app_window_presentation`, parsed. */
function persistedMap(): Record<string, string> {
  const entry = [...saved].reverse().find((s) => s.key === 'app_window_presentation');
  return entry ? JSON.parse(entry.value) : {};
}

beforeEach(() => {
  settings = {};
  saved.length = 0;
  commands.length = 0;
  liveSessions = [];
  resetAppPresentationStoreForTests();
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

describe('Spec #2955 ST-3 — Settings → Apps section', () => {
  it('lists one row per showable app and excludes non-showable features', async () => {
    renderSection();

    expect(await screen.findByTestId('app-presentation-settings')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-terminal')).toBeTruthy());
    expect(screen.getByTestId('app-presentation-row-doom')).toBeTruthy();
    expect(screen.getByTestId('app-presentation-row-query-viewer')).toBeTruthy();
    expect(screen.queryByTestId('app-presentation-row-hidden-app')).toBeNull();
  });

  it('shows a pre-hydration skeleton, then rows in place', async () => {
    renderSection();

    // The hydration read is async — the very first paint is the skeleton.
    expect(screen.getByTestId('app-presentation-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-terminal')).toBeTruthy());
    expect(screen.queryByTestId('app-presentation-loading')).toBeNull();
  });

  it('defaults every app to "Main window" with the visible Main/Own labels', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-terminal')).toBeTruthy());

    await waitFor(() => expect(radio('terminal', 'same-window')).toHaveAttribute('aria-checked', 'true'));
    expect(radio('terminal', 'new-window')).toHaveAttribute('aria-checked', 'false');
    expect(radio('doom', 'same-window')).toHaveAttribute('aria-checked', 'true');

    // Labels are the user-facing mode names, distinct from the wire values.
    expect(screen.getAllByText('Main window').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Own window').length).toBeGreaterThan(0);
  });

  it('writes the per-app map immediately and tears the superseded host down (no Save footer)', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-terminal')).toBeTruthy());

    choose('terminal', 'new-window');

    await waitFor(() => expect(persistedMap()).toEqual({ terminal: 'new-window' }));
    // Native host teardown dispatched (idempotent; true only when one existed).
    expect(commands).toContain('close_app_window');
    // The radio repaints from the optimistic store move.
    await waitFor(() => expect(radio('terminal', 'new-window')).toHaveAttribute('aria-checked', 'true'));
    // ONE status region announces the change.
    await waitFor(() =>
      expect(screen.getByTestId('app-presentation-status')).toHaveTextContent(
        'Terminal now opens in its own window.',
      ),
    );
  });

  it('persists a non-Terminal app with no confirm dialog', async () => {
    liveSessions = [{ status: 'running' }];
    renderSection();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-doom')).toBeTruthy());

    choose('doom', 'new-window');

    await waitFor(() => expect(persistedMap()).toEqual({ doom: 'new-window' }));
    expect(screen.queryByTestId('app-presentation-change-confirm')).toBeNull();
  });

  it('lists the factory app with a disabled "Own window" + note, selected on Main window', async () => {
    renderSection();
    await waitFor(() =>
      expect(screen.getByTestId('app-presentation-row-query-viewer')).toBeTruthy(),
    );

    expect(screen.getByTestId('app-presentation-multi-window-note-query-viewer')).toBeTruthy();
    expect(radio('query-viewer', 'new-window')).toBeDisabled();
    expect(radio('query-viewer', 'same-window')).toHaveAttribute('aria-checked', 'true');
  });

  it('gates the Terminal change behind a confirm when a live host exists; Cancel mutates nothing', async () => {
    liveSessions = [{ status: 'running' }];
    renderSection();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-terminal')).toBeTruthy());

    choose('terminal', 'new-window');

    const cancel = await screen.findByTestId('app-presentation-change-cancel');
    expect(cancel).toBeTruthy();
    fireEvent.click(cancel);

    await waitFor(() =>
      expect(screen.queryByTestId('app-presentation-change-confirm')).toBeNull(),
    );
    expect(getAppPresentation('terminal')).toBe('same-window');
    expect(persistedMap()).toEqual({});
    expect(commands).not.toContain('close_app_window');
  });

  it('Confirm applies the Terminal mode and tears the superseded host down', async () => {
    liveSessions = [{ status: 'running' }];
    renderSection();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-terminal')).toBeTruthy());

    choose('terminal', 'new-window');
    fireEvent.click(await screen.findByTestId('app-presentation-change-confirm'));

    await waitFor(() => expect(persistedMap()).toEqual({ terminal: 'new-window' }));
    expect(getAppPresentation('terminal')).toBe('new-window');
    expect(commands).toContain('close_app_window');
    await waitFor(() =>
      expect(radio('terminal', 'new-window')).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('mounts exactly ONE role="status" region', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('app-presentation-row-terminal')).toBeTruthy());
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
