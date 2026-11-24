/**
 * Spec #3193 ST-2 — IngestAutostartSettings (Settings → Background capture).
 *
 * Covers the 9-state matrix the UI/UX Expert bound: loading / off / on /
 * applying / just-set-on / just-set-off / error / unavailable / stale-entry,
 * the exact copy, the testid set (`settings-ingest-autostart-timing` present,
 * `settings-ingest-daemon-status` retired), ONE polite live region, and the
 * ABSENCE of every retired daemon/elevation string (a passing "On" assertion
 * that still renders "Start daemon at login" would be a false PASS).
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

vi.mock('@/applications/settings', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue(false),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

import { adapterBridge } from '@/shared/utils/adapterBridge';
import { IngestAutostartSettings } from '../IngestAutostartSettings';

const invokeMock = vi.mocked(adapterBridge.invoke);

// ── Exact copy (UI/UX copy table — verbatim) ─────────────────────────────────

const STATUS_ON = 'Background capture: On';
const STATUS_OFF = 'Background capture: Off';
const STATUS_UNAVAILABLE = 'Background capture: Unavailable on this platform';
const DETAIL_ON = 'Fredo starts in the background the next time you sign in.';
const DETAIL_OFF = 'Fredo does not start when you sign in. Capture runs only while Fredo is open.';
const DETAIL_ON_JUST_SET =
  'Takes effect the next time you sign in. This session is already capturing, so nothing changes right now.';
const DETAIL_OFF_JUST_SET =
  'The login item is removed. This session keeps capturing until you quit Fredo.';
const DETAIL_UNAVAILABLE =
  'The login item is available on Windows only for now. Fredo still captures while it is open.';
const APPLYING = 'Applying…';
const ERROR_PREFIX = 'Could not update background capture:';
const A11Y_LABEL = 'Start background capture when I sign in';

/** Every string the UI/UX Expert retired from this surface. */
const RETIRED_COPY = [
  'Headless ingest daemon',
  'Start daemon at login',
  'Runs fredo ingest at login',
  'Installs a per-user Windows login entry.',
  'No admin rights required.',
  'Auto-start on login',
  'No login entry installed.',
  'Daemon:',
  'Attached to a headless daemon',
  'Running (this app owns the cluster)',
  'Starting…',
  'Stopped / failed',
  'Entry:',
  'Command:',
  'fredo ingest',
  '--background',
  'registry',
  'service',
  'admin',
  'elevation',
  'HKCU',
];

// ── Backend views ────────────────────────────────────────────────────────────

const COMMAND = '"C:\\Program Files\\Fredo\\fredo.exe" --background';
const FOREIGN_COMMAND = '"C:\\Program Files\\Contoso\\contoso.exe" --background';
const ENTRY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\FredoIngest';

const OFF_VIEW = { enabled: false, command: null, entry: null, available: true, owned: true };
const ON_VIEW = { enabled: true, command: COMMAND, entry: ENTRY, available: true, owned: true };
const UNAVAILABLE_VIEW = { ...OFF_VIEW, available: false, owned: false };
const STALE_VIEW = {
  enabled: true,
  command: FOREIGN_COMMAND,
  entry: ENTRY,
  available: true,
  owned: false,
};

/** Wire the backend read (+ write) for a test. */
function wire(options: { get?: unknown; set?: unknown }): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === 'ingest_autostart_get') return Promise.resolve(options.get);
    if (command === 'ingest_autostart_set') {
      return options.set instanceof Error
        ? Promise.reject(options.set)
        : Promise.resolve(options.set);
    }
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

function timing(): HTMLElement {
  return screen.getByTestId('settings-ingest-autostart-timing');
}

/** Fail if ANY retired daemon/elevation/plumbing string is rendered. */
function expectNoRetiredCopy(): void {
  const text = (screen.getByTestId('settings-ingest-autostart-section').textContent ?? '').toLowerCase();
  for (const retired of RETIRED_COPY) {
    expect(text).not.toContain(retired.toLowerCase());
  }
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe('#3193 ST-2 — Settings → Background capture', () => {
  it('shows skeletons while the registry read is in flight and never guesses Off', () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderWithChakra(<IngestAutostartSettings />);

    expect(screen.getByTestId('settings-ingest-autostart-section')).toBeInTheDocument();
    expect(screen.getByTestId('settings-ingest-autostart-toggle-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-ingest-autostart-toggle')).toBeNull();
    expect(screen.getByTestId('settings-ingest-autostart-status')).toBeInTheDocument();
    expect(timing()).toBeInTheDocument();
    expect(screen.queryByText(STATUS_OFF)).toBeNull();
    expect(screen.queryByText(STATUS_ON)).toBeNull();
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the steady Off state with the permanent timing line', async () => {
    wire({ get: OFF_VIEW });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText(STATUS_OFF)).toBeInTheDocument();
    expect(timing()).toHaveTextContent(DETAIL_OFF);

    const input = toggleInput();
    expect(input).toHaveAttribute('type', 'checkbox');
    expect(input).toHaveAccessibleName(A11Y_LABEL);
    expect(input).not.toBeChecked();
    expect(input).not.toBeDisabled();
    // The timing constraint is described to the switch (a11y §7).
    expect(input).toHaveAttribute(
      'aria-describedby',
      'settings-ingest-autostart-help settings-ingest-autostart-timing',
    );

    // Exactly ONE polite live region for the section.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false');
    expectNoRetiredCopy();
  });

  it('renders the steady On state with the timing line stated too', async () => {
    wire({ get: ON_VIEW });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText(STATUS_ON)).toBeInTheDocument();
    // The timing is permanent, not a one-off hint after a change.
    expect(timing()).toHaveTextContent(DETAIL_ON);
    expect(toggleInput()).toBeChecked();
    expect(toggleInput()).not.toBeDisabled();
    expectNoRetiredCopy();
  });

  it('shows Applying… during the write, then the just-set On sentence', async () => {
    let resolveSet: ((value: unknown) => void) | null = null;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'ingest_autostart_get') return Promise.resolve(OFF_VIEW);
      if (command === 'ingest_autostart_set') {
        return new Promise((resolve) => {
          resolveSet = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(STATUS_OFF);

    fireEvent.click(toggleInput());

    expect(await screen.findByText(APPLYING)).toBeInTheDocument();
    // The optimistic NEW value is stated immediately; the timing line carries the work.
    expect(screen.getByTestId('settings-ingest-autostart-status')).toHaveTextContent(STATUS_ON);
    expect(toggleInput()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

    resolveSet?.(ON_VIEW);
    expect(await screen.findByText(DETAIL_ON_JUST_SET)).toBeInTheDocument();
    expect(screen.getByTestId('settings-ingest-autostart-status')).toHaveTextContent(STATUS_ON);
    await waitFor(() => expect(toggleInput()).not.toBeDisabled());
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows the just-set Off sentence after the login item is removed', async () => {
    wire({ get: ON_VIEW, set: OFF_VIEW });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(STATUS_ON);

    fireEvent.click(toggleInput());

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('ingest_autostart_set', { enabled: false }),
    );
    expect(await screen.findByText(DETAIL_OFF_JUST_SET)).toBeInTheDocument();
    expect(screen.getByTestId('settings-ingest-autostart-status')).toHaveTextContent(STATUS_OFF);
    expect(toggleInput()).not.toBeChecked();
    // Off means "not at sign-in", never "capture stopped".
    expect(timing()).toHaveTextContent('This session keeps capturing until you quit Fredo.');
  });

  it('keeps the error persistent, in the timing slot, and reverts the switch', async () => {
    wire({ get: OFF_VIEW, set: new Error('reg.exe failed (access denied)') });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(STATUS_OFF);

    const input = toggleInput();
    fireEvent.click(input);

    expect(
      await screen.findByText(`${ERROR_PREFIX} reg.exe failed (access denied)`),
    ).toBeInTheDocument();
    // The prior state is stated truthfully; the error keeps its own line.
    expect(screen.getByTestId('settings-ingest-autostart-status')).toHaveTextContent(STATUS_OFF);
    expect(timing()).toHaveTextContent(ERROR_PREFIX);
    expect(input).not.toBeChecked();
    await waitFor(() => expect(input).not.toBeDisabled());
    // Persistent — never auto-dismissed.
    expect(timing()).toHaveTextContent(`${ERROR_PREFIX} reg.exe failed (access denied)`);
  });

  it('renders the unavailable state for a backend that reports available: false', async () => {
    wire({ get: UNAVAILABLE_VIEW });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText(STATUS_UNAVAILABLE)).toBeInTheDocument();
    expect(timing()).toHaveTextContent(DETAIL_UNAVAILABLE);

    const input = toggleInput();
    expect(input).not.toBeChecked();
    expect(input).toBeDisabled();
    // Unsupported is not a failure: no error styling, no error copy.
    expect(timing()).not.toHaveTextContent(ERROR_PREFIX);
    expect(screen.queryByText(/Could not update background capture:/)).toBeNull();
    expectNoRetiredCopy();
  });

  it('renders a present-but-foreign entry as Off and recovers it on enable', async () => {
    wire({ get: STALE_VIEW, set: ON_VIEW });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText(STATUS_OFF)).toBeInTheDocument();
    expect(timing()).toHaveTextContent(DETAIL_OFF);
    // Not displayed as a working On (it would claim capture starts at sign-in).
    expect(toggleInput()).not.toBeChecked();
    // Still operable: enabling rewrites the entry with this binary's form.
    expect(toggleInput()).not.toBeDisabled();
    expect(timing()).not.toHaveTextContent(ERROR_PREFIX);

    fireEvent.click(toggleInput());

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('ingest_autostart_set', { enabled: true }),
    );
    expect(await screen.findByText(STATUS_ON)).toBeInTheDocument();
    expect(timing()).toHaveTextContent(DETAIL_ON_JUST_SET);
    expect(toggleInput()).toBeChecked();
  });

  it('falls back to the legacy On/Off surface when the backend omits available/owned', async () => {
    // Boundary guard (G-413): the pre-#3193 three-field view must not fabricate
    // an unavailable/stale state the backend never reported.
    wire({ get: { enabled: true, command: COMMAND, entry: ENTRY } });
    renderWithChakra(<IngestAutostartSettings />);

    expect(await screen.findByText(STATUS_ON)).toBeInTheDocument();
    expect(toggleInput()).toBeChecked();
  });

  it('does not read the retired daemon status', async () => {
    wire({ get: OFF_VIEW });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(STATUS_OFF);

    expect(screen.queryByTestId('settings-ingest-daemon-status')).toBeNull();
    expect(document.querySelector('[data-testid="settings-ingest-daemon-status"]')).toBeNull();
    const commands = invokeMock.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain('pg_supervisor_status');
  });
});
