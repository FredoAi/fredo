/**
 * Spec #2992 ST-7 — IngestAutostartSettings behaviour.
 *
 * Covers the full state matrix (loading / off / on / in-flight / error; daemon
 * states disabled|starting|ready|failed|attached), the exact testids, the
 * effective-registry read on mount, the optimistic toggle + revert on error, and
 * the G-274 ellipsize contract (command `title`; entry/auto-start exempt).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

vi.mock('@/shared/utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: vi.fn(),
    listen: vi.fn().mockResolvedValue(() => {}),
  },
}));

vi.mock('@/features/settings', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue(false),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

import { adapterBridge } from '@/shared/utils/adapterBridge';
import { IngestAutostartSettings } from '../IngestAutostartSettings';

const invokeMock = vi.mocked(adapterBridge.invoke);

const OFF_VIEW = { enabled: false, command: null, entry: null };
const COMMAND = '"C:\\Program Files\\Fredo\\fredo.exe" ingest';
const ENTRY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\FredoIngest';
const ON_VIEW = { enabled: true, command: COMMAND, entry: ENTRY };

/** Wire the two backend reads (+ set) for a test. */
function wire(options: {
  get?: unknown;
  set?: unknown;
  daemon?: unknown;
}): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === 'ingest_autostart_get') return Promise.resolve(options.get);
    if (command === 'ingest_autostart_set') {
      return options.set instanceof Error
        ? Promise.reject(options.set)
        : Promise.resolve(options.set);
    }
    if (command === 'pg_supervisor_status') return Promise.resolve(options.daemon);
    return Promise.resolve(undefined);
  });
}

function toggleInput(): HTMLInputElement {
  const input = screen
    .getByTestId('settings-ingest-autostart-toggle')
    .querySelector('input');
  if (!input) throw new Error('switch input not found');
  return input as HTMLInputElement;
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe('#2992 ST-7 — IngestAutostartSettings', () => {
  it('shows skeletons while the initial reads are in flight', () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderWithChakra(<IngestAutostartSettings />);

    expect(screen.getByTestId('settings-ingest-autostart-section')).toBeInTheDocument();
    expect(
      screen.getByTestId('settings-ingest-autostart-toggle-skeleton'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('settings-ingest-autostart-toggle')).toBeNull();
    expect(screen.getByTestId('settings-ingest-autostart-status')).toBeInTheDocument();
    expect(screen.getByTestId('settings-ingest-daemon-status')).toBeInTheDocument();
  });

  it('renders the pre-feature Off surface with an accessible checkbox', async () => {
    wire({ get: OFF_VIEW, daemon: { state: 'disabled' } });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText('Auto-start on login: Off')).toBeInTheDocument();
    expect(screen.getByText('No login entry installed.')).toBeInTheDocument();
    expect(screen.getByText('Not running')).toBeInTheDocument();

    const input = toggleInput();
    expect(input).toHaveAttribute('type', 'checkbox');
    expect(input).toHaveAccessibleName('Start headless ingest daemon at login');
    expect(input).not.toBeChecked();
    expect(input).not.toBeDisabled();
  });

  it('reflects the effective registry state on mount (On + entry + command)', async () => {
    wire({ get: ON_VIEW, daemon: { state: 'attached' } });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText('Auto-start on login: On')).toBeInTheDocument();
    expect(screen.getByText('Attached to a headless daemon')).toBeInTheDocument();
    expect(toggleInput()).toBeChecked();

    // Entry line renders in full (exempt from G-274 truncation).
    const entryValue = screen.getByText(ENTRY);
    expect(entryValue).toHaveTextContent(ENTRY);
    expect(entryValue).not.toHaveAttribute('title');

    // G-274: the ONE ellipsize target is the command value (mono + title).
    const commandValue = screen.getByText(COMMAND);
    expect(commandValue).toHaveAttribute('title', COMMAND);
  });

  it('optimistically flips and persists via ingest_autostart_set', async () => {
    wire({ get: OFF_VIEW, set: ON_VIEW, daemon: { state: 'disabled' } });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText('Auto-start on login: Off');
    fireEvent.click(toggleInput());

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('ingest_autostart_set', { enabled: true }),
    );
    expect(await screen.findByText('Auto-start on login: On')).toBeInTheDocument();
    expect(toggleInput()).toBeChecked();
  });

  it('shows the persistent error and reverts the switch when set rejects', async () => {
    wire({
      get: OFF_VIEW,
      set: new Error('reg.exe failed (access denied)'),
      daemon: { state: 'disabled' },
    });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText('Auto-start on login: Off');
    const input = toggleInput();
    fireEvent.click(input);

    expect(
      await screen.findByText(
        'Could not update login auto-start: reg.exe failed (access denied)',
      ),
    ).toBeInTheDocument();
    expect(input).not.toBeChecked();
    await waitFor(() => expect(input).not.toBeDisabled());
  });

  it.each([
    ['starting', 'Starting…'],
    ['ready', 'Running (this app owns the cluster)'],
    ['failed', 'Stopped / failed'],
    ['attached', 'Attached to a headless daemon'],
    ['disabled', 'Not running'],
  ])('renders daemon state %s as "%s"', async (state, label) => {
    wire({ get: OFF_VIEW, daemon: { state } });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});
