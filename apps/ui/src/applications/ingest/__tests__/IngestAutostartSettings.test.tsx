/**
 * Spec #3195 ST-2 — IngestAutostartSettings (Settings → Background capture).
 *
 * The pane renders TWO independent subjects and the suite keeps them apart:
 *
 *   CAPTURE  — `settings-ingest-capture-status` + `settings-ingest-capture-detail`,
 *              derived from the `stream_health` read (running / not running /
 *              unavailable). It may never be derived from the login entry, and
 *              an unreadable probe may never render a stopped claim (AC4).
 *   ENTRY    — the switch's `checked` state + `settings-ingest-autostart-timing`
 *              (steady on/off, applying, just-set, error, unavailable, stale).
 *
 * Covered states: loading / running / not running (generic) / not running
 * (typed `addrInUse` with receiver+port, both receivers) / unavailable /
 * applying / toggle error / stale entry / steady-poll (no region churn).
 *
 * Also pinned: ONE `role="status"` with `aria-atomic="true"`, `CAPTURE_SCOPE`
 * present in every state and OUTSIDE that region, the two NEW testids, and the
 * ABSENCE of the retired ids (`settings-ingest-autostart-status`,
 * `settings-ingest-daemon-status`) and of every retired string — a passing
 * "Running" assertion that still renders the retired On/Off capture line would
 * be a false PASS (this suite's whole reason for existing).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { STREAM_HEALTH_CHECK_INTERVAL_MS } from '@/shared/hooks/streamHealth';

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

// ── Exact copy (UI/UX §2 copy table — verbatim; A-1 governs) ─────────────────

const SECTION_TITLE = 'Background capture';
const SECTION_HELP = 'Capture agent activity even when no Fredo window is open.';
const CAPTURE_SCOPE =
  'Capture runs whenever Fredo is running — including when no Fredo window is open. It stops when you quit Fredo.';
const CAPTURE_RUNNING = 'Capture: Running';
const CAPTURE_NOT_RUNNING = 'Capture: Not running';
const CAPTURE_UNAVAILABLE = 'Capture: Status unavailable';
const CAPTURE_NOT_RUNNING_DETAIL = 'Capture is not receiving agent activity right now.';
const CAPTURE_UNAVAILABLE_DETAIL = 'Fredo could not report whether capture is running.';
const DETAIL_ON = 'Fredo starts in the background the next time you sign in.';
const DETAIL_OFF = 'Fredo does not start when you sign in.';
const DETAIL_ON_JUST_SET = 'Takes effect the next time you sign in. Nothing else changes now.';
const DETAIL_OFF_JUST_SET =
  'The login item is removed. Nothing changes in this session until you quit Fredo.';
const DETAIL_UNAVAILABLE = 'The login item is available on Windows only for now.';
const APPLYING = 'Applying…';
const ERROR_PREFIX = 'Could not update background capture:';
const A11Y_LABEL = 'Start background capture when I sign in';

function ingestDetail(receiver: 'gRPC' | 'HTTP', port: number): string {
  return `Capture is not receiving agent activity: the ${receiver} telemetry receiver on port ${port} could not start.`;
}

/** Every string retired from this surface — the capture/login-entry split must be TOTAL. */
const RETIRED_COPY = [
  // #3193 retirements (daemon / elevation / plumbing vocabulary)
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
  // #3195 retirements — the login-entry boolean rendered in capture vocabulary,
  // the window-scoped lifetime claims, and the capture claims made by the
  // login-entry sentences (A-1).
  'Background capture: On',
  'Background capture: Off',
  'Background capture: Unavailable on this platform',
  'daemon',
  'attach',
  'headless',
  'second process',
  'background process',
  'Capture runs only while Fredo is open',
  'still captures while it is open',
  'still captures while it is running',
  'This session is already capturing',
  'This session keeps capturing',
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

// ── `stream_health` fixtures (the REAL snapshot shape) ───────────────────────

const HEALTHY = { seq: 7, ingestConnected: true, ageMs: 240, forced: false };
const INGEST_DOWN = { seq: 8, ingestConnected: false, ageMs: 240, forced: true };
const STALE_HEARTBEAT = { seq: 9, ingestConnected: true, ageMs: 20_000, forced: true };
const ADDR_IN_USE_GRPC = {
  ...INGEST_DOWN,
  ingestFailure: {
    receiver: 'grpc',
    port: 4317,
    code: 'addrInUse',
    message: 'address already in use',
  },
};
const BIND_FAILED_HTTP = {
  ...INGEST_DOWN,
  ingestFailure: {
    receiver: 'http',
    port: 4318,
    code: 'bindFailed',
    message: 'could not bind',
  },
};
const MALFORMED_FAILURE = {
  ...INGEST_DOWN,
  ingestFailure: { receiver: 'grpc', port: 0, code: 'addrInUse', message: 'address in use' },
};

interface WireOptions {
  get?: unknown;
  set?: unknown;
  /** The `stream_health` result. `null` = the transport returned nothing; omit = HEALTHY. */
  health?: unknown;
}

/** Wire the registry read/write and the capture probe for a test. */
function wire(options: WireOptions): void {
  const health = 'health' in options ? options.health : HEALTHY;
  invokeMock.mockImplementation((command: string) => {
    if (command === 'ingest_autostart_get') return Promise.resolve(options.get);
    if (command === 'ingest_autostart_set') {
      return options.set instanceof Error
        ? Promise.reject(options.set)
        : Promise.resolve(options.set);
    }
    if (command === 'stream_health') return Promise.resolve(health);
    return Promise.resolve(undefined);
  });
}

function section(): HTMLElement {
  return screen.getByTestId('settings-ingest-autostart-section');
}

function region(): HTMLElement {
  return screen.getByRole('status');
}

function captureWordLine(): HTMLElement {
  return screen.getByTestId('settings-ingest-capture-status');
}

function captureDetailEl(): HTMLElement | null {
  return screen.queryByTestId('settings-ingest-capture-detail');
}

function captureDetailText(): string | null {
  return captureDetailEl()?.textContent ?? null;
}

function scopeEl(): HTMLElement {
  return screen.getByText(CAPTURE_SCOPE);
}

function timing(): HTMLElement {
  return screen.getByTestId('settings-ingest-autostart-timing');
}

function toggleInput(): HTMLInputElement {
  const input = screen.getByTestId('settings-ingest-autostart-toggle').querySelector('input');
  if (!input) throw new Error('switch input not found');
  return input as HTMLInputElement;
}

function invokeCommands(): string[] {
  return invokeMock.mock.calls.map((call) => call[0]);
}

function countInvokes(command: string): number {
  return invokeCommands().filter((name) => name === command).length;
}

/**
 * Drain the async effect chain and flush React's queue under fake timers.
 * `advanceTimersByTimeAsync` alone resolves the timer callback, not the promise
 * chain the callback started, so the microtask drain is explicit and bounded.
 */
async function settleFakeTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let hop = 0; hop < 12; hop += 1) {
      await Promise.resolve();
    }
  });
}

/** Fail if ANY retired string is rendered (lower-cased comparison). */
function expectNoRetiredCopy(): void {
  const text = (section().textContent ?? '').toLowerCase();
  for (const retired of RETIRED_COPY) {
    expect(text).not.toContain(retired.toLowerCase());
  }
}

/** The two retired test ids must be absent from the whole document. */
function expectRetiredIdsAbsent(): void {
  expect(screen.queryByTestId('settings-ingest-autostart-status')).toBeNull();
  expect(document.querySelector('[data-testid="settings-ingest-autostart-status"]')).toBeNull();
  expect(screen.queryByTestId('settings-ingest-daemon-status')).toBeNull();
  expect(document.querySelector('[data-testid="settings-ingest-daemon-status"]')).toBeNull();
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe('#3195 ST-2 — Settings → Background capture', () => {
  it('renders placeholders while both reads are in flight and never guesses a word', () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderWithChakra(<IngestAutostartSettings />);

    expect(section()).toBeInTheDocument();
    expect(screen.getByTestId('settings-ingest-autostart-toggle-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-ingest-autostart-toggle')).toBeNull();

    // The capture block exists and is EMPTY — a placeholder, never a word.
    expect(captureWordLine()).toBeInTheDocument();
    expect(captureWordLine().textContent).toBe('');
    expect(captureDetailEl()).toBeNull();
    expect(timing()).toBeInTheDocument();

    expect(screen.queryByText(CAPTURE_RUNNING)).toBeNull();
    expect(screen.queryByText(CAPTURE_NOT_RUNNING)).toBeNull();
    expect(screen.queryByText(CAPTURE_UNAVAILABLE)).toBeNull();

    // Busy holds the region while the FIRST read is unresolved.
    expect(region()).toHaveAttribute('aria-busy', 'true');

    // The scope sentence is present from the first frame and OUTSIDE the region.
    expect(scopeEl()).toBeInTheDocument();
    expect(region().contains(scopeEl())).toBe(false);
  });

  it('states capture running and the steady Off login entry, with the scope outside the region', async () => {
    wire({ get: OFF_VIEW, health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_RUNNING);
    await screen.findByText(DETAIL_OFF);

    // Exact word — no retired "Background capture: …" vocabulary anywhere.
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
    // Running needs no explanation: the detail is ABSENT (UI/UX §3 row 2).
    expect(captureDetailEl()).toBeNull();
    // The two subjects never claim each other (U-7): Off is about sign-in only.
    expect(timing()).toHaveTextContent(DETAIL_OFF);
    expect(timing()).not.toHaveTextContent('captur');

    expect(section()).toHaveTextContent(SECTION_TITLE);
    expect(section()).toHaveTextContent(SECTION_HELP);

    const input = toggleInput();
    expect(input).toHaveAttribute('type', 'checkbox');
    expect(input).toHaveAccessibleName(A11Y_LABEL);
    expect(input).not.toBeChecked();
    expect(input).not.toBeDisabled();
    expect(input).toHaveAttribute(
      'aria-describedby',
      'settings-ingest-autostart-help settings-ingest-autostart-timing',
    );

    // Exactly ONE polite atomic live region for the section.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region()).toHaveAttribute('aria-atomic', 'true');
    await waitFor(() => expect(region()).toHaveAttribute('aria-busy', 'false'));

    // Scope: present and NOT announced (outside the live region).
    expect(region().contains(scopeEl())).toBe(false);

    expectRetiredIdsAbsent();
    expectNoRetiredCopy();
  });

  it('states capture running against an ON login entry, stating the sign-in sentence too', async () => {
    wire({ get: ON_VIEW, health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_RUNNING);
    expect(timing()).toHaveTextContent(DETAIL_ON);
    expect(toggleInput()).toBeChecked();
    expect(toggleInput()).not.toBeDisabled();
    expect(captureDetailEl()).toBeNull();
    expectNoRetiredCopy();
  });

  it('reports not running with the generic reason when the probe is degraded', async () => {
    wire({ get: OFF_VIEW, health: INGEST_DOWN });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_NOT_RUNNING);
    expect(captureWordLine().textContent).toBe(CAPTURE_NOT_RUNNING);
    expect(captureDetailText()).toBe(CAPTURE_NOT_RUNNING_DETAIL);
    // The process IS running — the card must never claim otherwise.
    expect(section().textContent ?? '').not.toContain('Fredo is not running');

    expectRetiredIdsAbsent();
    expectNoRetiredCopy();
  });

  it('reports the stale-heartbeat route as not running with no receiver named', async () => {
    wire({ get: OFF_VIEW, health: STALE_HEARTBEAT });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_NOT_RUNNING);
    expect(captureDetailText()).toBe(CAPTURE_NOT_RUNNING_DETAIL);
    expect(captureDetailText()).not.toContain('receiver');
  });

  it('names the gRPC receiver and port for a typed addrInUse failure', async () => {
    wire({ get: OFF_VIEW, health: ADDR_IN_USE_GRPC });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_NOT_RUNNING);
    expect(captureWordLine().textContent).toBe(CAPTURE_NOT_RUNNING);
    expect(captureDetailText()).toBe(ingestDetail('gRPC', 4317));
    expectNoRetiredCopy();
  });

  it('names the HTTP receiver and port for a typed bindFailed failure', async () => {
    wire({ get: OFF_VIEW, health: BIND_FAILED_HTTP });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_NOT_RUNNING);
    expect(captureDetailText()).toBe(ingestDetail('HTTP', 4318));
  });

  it('drops a malformed typed failure and falls back to the generic reason', async () => {
    wire({ get: OFF_VIEW, health: MALFORMED_FAILURE });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_NOT_RUNNING);
    expect(captureDetailText()).toBe(CAPTURE_NOT_RUNNING_DETAIL);
    expect(section().textContent ?? '').not.toContain('undefined');
    expect(section().textContent ?? '').not.toContain('NaN');
  });

  it('reads Capture: Status unavailable — never a stopped claim — when the probe cannot be read', async () => {
    wire({ get: OFF_VIEW, health: null });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(CAPTURE_UNAVAILABLE);
    expect(captureWordLine().textContent).toBe(CAPTURE_UNAVAILABLE);
    expect(captureDetailText()).toBe(CAPTURE_UNAVAILABLE_DETAIL);
    // AC4's negative: an unreadable probe may NEVER read as not running.
    expect(screen.queryByText(CAPTURE_NOT_RUNNING)).toBeNull();
    expect(section().textContent ?? '').not.toContain(CAPTURE_NOT_RUNNING);
    expectNoRetiredCopy();
  });

  it('renders the unavailable login item while the capture line stays independent', async () => {
    wire({ get: UNAVAILABLE_VIEW, health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(DETAIL_UNAVAILABLE);
    // Capture is platform-independent: it still reports running.
    await screen.findByText(CAPTURE_RUNNING);
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
    // The login-item limitation makes no capture claim (A-1): the retired
    // "still captures while…" clause is gone entirely.
    expect(timing()).not.toHaveTextContent('captur');
    expect(timing()).not.toHaveTextContent('Fredo');

    const input = toggleInput();
    expect(input).not.toBeChecked();
    expect(input).toBeDisabled();
    // Unsupported is not a failure: no error styling, no error copy.
    expect(timing()).not.toHaveTextContent(ERROR_PREFIX);
    expect(screen.queryByText(/Could not update background capture:/)).toBeNull();
    expectNoRetiredCopy();
  });

  it('keeps the last settled capture word while a toggle write is in flight', async () => {
    let resolveSet: ((value: unknown) => void) | null = null;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'ingest_autostart_get') return Promise.resolve(OFF_VIEW);
      if (command === 'ingest_autostart_set') {
        return new Promise((resolve) => {
          resolveSet = resolve;
        });
      }
      return Promise.resolve(HEALTHY);
    });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(CAPTURE_RUNNING);
    await screen.findByText(DETAIL_OFF);

    fireEvent.click(toggleInput());

    expect(await screen.findByText(APPLYING)).toBeInTheDocument();
    // The switch is optimistic; the CAPTURE word never moves with it.
    expect(toggleInput()).toBeChecked();
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
    expect(captureDetailEl()).toBeNull();
    expect(toggleInput()).toBeDisabled();
    expect(region()).toHaveAttribute('aria-busy', 'true');

    resolveSet?.(ON_VIEW);
    expect(await screen.findByText(DETAIL_ON_JUST_SET)).toBeInTheDocument();
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
    await waitFor(() => expect(toggleInput()).not.toBeDisabled());
    expect(region()).toHaveAttribute('aria-busy', 'false');
  });

  it('shows the just-set Off sentence after the login item is removed', async () => {
    wire({ get: ON_VIEW, set: OFF_VIEW, health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(DETAIL_ON);

    fireEvent.click(toggleInput());

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('ingest_autostart_set', { enabled: false }),
    );
    expect(await screen.findByText(DETAIL_OFF_JUST_SET)).toBeInTheDocument();
    expect(toggleInput()).not.toBeChecked();
    // Off means "not at sign-in", never "capture stopped" (A-1).
    expect(timing()).not.toHaveTextContent('captur');
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
  });

  it('keeps a toggle error persistent, in the timing slot, with the capture word unchanged', async () => {
    wire({ get: OFF_VIEW, set: new Error('reg.exe failed (access denied)'), health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(DETAIL_OFF);

    const input = toggleInput();
    fireEvent.click(input);

    expect(await screen.findByText(`${ERROR_PREFIX} reg.exe failed (access denied)`)).toBeInTheDocument();
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
    expect(timing()).toHaveTextContent(ERROR_PREFIX);
    expect(input).not.toBeChecked();
    await waitFor(() => expect(input).not.toBeDisabled());
    // Persistent — never auto-dismissed.
    expect(timing()).toHaveTextContent(`${ERROR_PREFIX} reg.exe failed (access denied)`);
    expectRetiredIdsAbsent();
  });

  it('renders a present-but-foreign entry as Off, leaving the capture line untouched', async () => {
    wire({ get: STALE_VIEW, set: ON_VIEW, health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(DETAIL_OFF);
    // The registry cannot change capture liveness: running stays running.
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
    expect(timing()).toHaveTextContent(DETAIL_OFF);
    expect(toggleInput()).not.toBeChecked();
    expect(toggleInput()).not.toBeDisabled();
    expect(timing()).not.toHaveTextContent(ERROR_PREFIX);

    fireEvent.click(toggleInput());

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('ingest_autostart_set', { enabled: true }),
    );
    expect(await screen.findByText(DETAIL_ON_JUST_SET)).toBeInTheDocument();
    expect(toggleInput()).toBeChecked();
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
  });

  it('falls back to the legacy Off surface when the backend omits available/owned', async () => {
    // Boundary guard (G-413): the pre-#3193 three-field view must not fabricate
    // an unavailable/stale state the backend never reported.
    wire({ get: { enabled: true, command: COMMAND, entry: ENTRY }, health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);

    await screen.findByText(DETAIL_ON);
    expect(toggleInput()).toBeChecked();
    expect(captureWordLine().textContent).toBe(CAPTURE_RUNNING);
  });

  it('does not read the retired daemon status or pg_supervisor_status', async () => {
    wire({ get: OFF_VIEW, health: HEALTHY });
    renderWithChakra(<IngestAutostartSettings />);
    await screen.findByText(CAPTURE_RUNNING);

    expectRetiredIdsAbsent();
    const commands = invokeCommands();
    expect(commands).not.toContain('pg_supervisor_status');
    // The pane's whole IPC surface: the registry read + the capture probe.
    expect(new Set(commands)).toEqual(new Set(['ingest_autostart_get', 'stream_health']));
  });

  it('does not mutate the live region on a steady poll and never flips aria-busy', async () => {
    vi.useFakeTimers();
    try {
      wire({ get: OFF_VIEW, health: HEALTHY });
      const { unmount } = renderWithChakra(<IngestAutostartSettings />);
      await settleFakeTimers(0);

      const settledText = region().textContent;
      expect(settledText).toContain(CAPTURE_RUNNING);
      expect(region()).toHaveAttribute('aria-busy', 'false');
      const afterMount = countInvokes('stream_health');
      expect(afterMount).toBe(1);

      for (let tick = 0; tick < 6; tick += 1) {
        await settleFakeTimers(STREAM_HEALTH_CHECK_INTERVAL_MS);
        // ONE probe per interval — never a probe per render.
        expect(countInvokes('stream_health')).toBe(afterMount + tick + 1);
        // A steady poll mutates nothing in the live region.
        expect(region().textContent).toBe(settledText);
        expect(region()).toHaveAttribute('aria-busy', 'false');
      }
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the poll on unmount — zero further probes', async () => {
    vi.useFakeTimers();
    try {
      wire({ get: OFF_VIEW, health: HEALTHY });
      const { unmount } = renderWithChakra(<IngestAutostartSettings />);
      await settleFakeTimers(0);
      const afterMount = countInvokes('stream_health');

      unmount();
      await settleFakeTimers(STREAM_HEALTH_CHECK_INTERVAL_MS * 3);

      expect(countInvokes('stream_health')).toBe(afterMount);
    } finally {
      vi.useRealTimers();
    }
  });
});
