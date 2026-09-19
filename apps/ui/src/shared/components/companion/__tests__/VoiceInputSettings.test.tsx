/**
 * VoiceInputSettings — #2877 ST-4 unit contract (DR-1/2/3/5/6/10/11/12).
 *
 * Proves the extracted settings group without a Tauri host:
 *   • C0 — the speech-handling selector (#2897 ST-1 / REQ-1): the closed
 *     `Local transcription` (DEFAULT) | `Model audio` set, persisted as
 *     `Fredo_companion_voice_handling`, healing every non-`model` raw to
 *     `'local'`, and announced through the settings live region;
 *   • C1 — the master enable switch (frozen `aria-label="Enable voice input"`,
 *     label `Hold Space to dictate` — re-pointed off the retired Ctrl+Space
 *     dictation promise by #2882 ST-7 / R-7, DEFAULT OFF) persists the choice
 *     and, on OFF while a session is live, stops the session + releases the mic
 *     (R-1.1 / DR-2);
 *   • R-1.3 — the engine status line shows idle / listening / error;
 *   • C2 — the model row's six DR-3 states with the single primary action + the
 *     Re-check action, aggregate determinate progress, the resolved location on
 *     ready AND error, and curated `role="alert"` copy (R-2.1–R-2.5 / R-5.2);
 *   • C3 — the `chakra.select` device selector (never `NativeSelect`) with
 *     System-default + enumerated devices, the checking / no-device / vanished /
 *     permission-denied sub-states + Re-scan, persisted
 *     `Fredo_companion_voice_device_id`, and NO silent switch for a vanished
 *     selection (R-3.2 / R-5.1 / AC4);
 *   • C4 — the autosend switch (DEFAULT OFF) with flipping behaviour captions,
 *     persisted `Fredo_companion_voice_autosend` (R-1.2 / DR-6);
 *   • DR-10 — one persistent polite live region for settings state changes;
 *   • DR-12 — token-first source pins (no `var(--x)NN` alpha-append, `tint()`
 *     for every alpha, unit-string geometry).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  VOICE_ENABLED_SETTING_KEY,
  VOICE_AUTOSEND_SETTING_KEY,
  VOICE_DEVICE_ID_SETTING_KEY,
  VOICE_HANDLING_SETTING_KEY,
  DEFAULT_VOICE_HANDLING,
} from '@/shared/contexts/CompanionContext';
import {
  VoiceInputSettings,
  VOICE_ENGINE_NAME,
  deriveSttModelUiState,
  deriveDeviceRowView,
  formatBytes,
  aggregateBytes,
  sttModelRowDataState,
  voiceErrorCopyFor,
} from '@/shared/components/companion/VoiceInputSettings';
import type { VoiceInputSettingsProps } from '@/shared/components/companion/VoiceInputSettings';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  ModelFileId,
  ModelFileState,
  ModelFileStatus,
  SttDeviceProbe,
  SttModelReadiness,
} from '@/shared/components/companion/companionReadiness';

const STT_IDS: readonly ModelFileId[] = ['sttTokens', 'sttEncoder', 'sttDecoder', 'sttJoiner'];

// ── #2882 ST-7 pinned copy (R-7) ─────────────────────────────────────────────
// Literal pins for the re-pointed voice-settings copy (G-125): the enable label
// teaches hold-Space instead of the retired Ctrl+Space dictation shortcut, the
// help carries the shipped gesture end to end, and the `disabled` engine error
// points at the new label rather than the gone shortcut.
const VOICE_ENABLE_LABEL = 'Hold Space to dictate';
const VOICE_ENABLE_HELP_TEXT =
  'In the launcher search bar, hold Space to dictate; release and the words land in the bar as ' +
  'editable text. Enter then sends them to Fredo — with “Send voice transcripts automatically” ' +
  'on, they’re sent the moment you release. A dictated transcript always goes to Fredo and never ' +
  'opens an app, even after you edit it. Ctrl+Space only brings the search bar forward; it never ' +
  'starts dictation. Transcription runs locally — nothing leaves this machine.';
const VOICE_DISABLED_ERROR_TEXT =
  'Voice input is off. Turn on “Hold Space to dictate” above, then hold Space in the launcher search bar.';

function sttFile(
  id: ModelFileId,
  state: ModelFileState,
  overrides: Partial<ModelFileStatus> = {},
): ModelFileStatus {
  return {
    id,
    filename: `${id}.bin`,
    relativePath: `${id}.bin`,
    state,
    downloadedBytes: state === 'present' ? 10 : 0,
    expectedBytes: 10,
    detail: null,
    path: state === 'present' ? `C:\\models\\stt\\${id}.bin` : null,
    ...overrides,
  };
}

const READY_MODEL: SttModelReadiness = {
  ready: true,
  files: STT_IDS.map((id) => sttFile(id, 'present')),
  location: 'C:\\models\\stt',
};

const NOT_INSTALLED_MODEL: SttModelReadiness = {
  ready: false,
  files: STT_IDS.map((id) => sttFile(id, 'missing')),
  location: null,
};

const DOWNLOADING_MODEL: SttModelReadiness = {
  ready: false,
  files: [
    sttFile('sttTokens', 'present', { downloadedBytes: 100, expectedBytes: 100 }),
    sttFile('sttEncoder', 'downloading', { downloadedBytes: 25, expectedBytes: 100 }),
    sttFile('sttDecoder', 'missing', { downloadedBytes: 0, expectedBytes: 0 }),
    sttFile('sttJoiner', 'missing', { downloadedBytes: 0, expectedBytes: 0 }),
  ],
  location: 'C:\\models\\stt',
};

const INTERRUPTED_MODEL: SttModelReadiness = {
  ready: false,
  files: [
    sttFile('sttTokens', 'present', { downloadedBytes: 100, expectedBytes: 100 }),
    sttFile('sttEncoder', 'missing', { downloadedBytes: 5, expectedBytes: 100 }),
    sttFile('sttDecoder', 'missing', { downloadedBytes: 0, expectedBytes: 0 }),
    sttFile('sttJoiner', 'missing', { downloadedBytes: 0, expectedBytes: 0 }),
  ],
  location: 'C:\\models\\stt',
};

const ERROR_MODEL: SttModelReadiness = {
  ready: false,
  files: [
    sttFile('sttTokens', 'present'),
    sttFile('sttEncoder', 'error', { detail: 'disk full' }),
    sttFile('sttDecoder', 'missing'),
    sttFile('sttJoiner', 'missing'),
  ],
  location: 'C:\\models\\stt',
};

function deviceProbe(overrides: Partial<SttDeviceProbe> = {}): SttDeviceProbe {
  return {
    state: 'devices',
    devices: [
      { id: 'Microphone (USB)', name: 'Microphone (USB)', isDefault: true },
      { id: 'Iriun Webcam', name: 'Iriun Webcam', isDefault: false },
    ],
    selectedId: null,
    code: null,
    ...overrides,
  };
}

// ── Listen mock (drives the app-global stt:* stream) ─────────────────────────

let listenHandlers = new Map<string, Array<(payload: unknown) => void>>();

function installListenMock(): void {
  listenHandlers = new Map();
  adapterBridge.setListen(async <T,>(event: string, handler: (payload: T) => void) => {
    const list = listenHandlers.get(event) ?? [];
    list.push(handler as (payload: unknown) => void);
    listenHandlers.set(event, list);
    return () => {};
  });
}

function emitEvent(event: string, payload: unknown): void {
  for (const handler of listenHandlers.get(event) ?? []) handler(payload);
}

function renderSettings(overrides: Partial<VoiceInputSettingsProps> = {}) {
  const props: VoiceInputSettingsProps = {
    sttModel: null,
    sttDevices: deviceProbe(),
    sttDownloading: false,
    sttError: null,
    onDownloadModel: vi.fn(),
    onRecheck: vi.fn(),
    onRescanDevices: vi.fn(),
    ...overrides,
  };
  const utils = renderWithChakra(
    <CompanionProvider>
      <VoiceInputSettings {...props} />
    </CompanionProvider>,
  );
  return { ...utils, props };
}

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  adapterBridge.setInvoke(async () => undefined);
  installListenMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
});

// ── Pure derivations ─────────────────────────────────────────────────────────

describe('VoiceInputSettings — pure derivations (#2877 ST-4)', () => {
  it('derives DR-3 model states from the readiness + action flags', () => {
    expect(
      deriveSttModelUiState({ model: null, downloading: false, error: null }),
    ).toBe('not-checked');
    expect(
      deriveSttModelUiState({ model: NOT_INSTALLED_MODEL, downloading: false, error: null }),
    ).toBe('not-installed');
    expect(
      deriveSttModelUiState({ model: DOWNLOADING_MODEL, downloading: false, error: null }),
    ).toBe('downloading');
    expect(
      deriveSttModelUiState({ model: READY_MODEL, downloading: false, error: null }),
    ).toBe('ready');
    expect(
      deriveSttModelUiState({ model: ERROR_MODEL, downloading: false, error: null }),
    ).toBe('error');
    expect(
      deriveSttModelUiState({ model: NOT_INSTALLED_MODEL, downloading: false, error: 'boom' }),
    ).toBe('error');
    expect(
      deriveSttModelUiState({ model: INTERRUPTED_MODEL, downloading: false, error: null }),
    ).toBe('interrupted');
    // An in-flight action wins over a stale error flag.
    expect(
      deriveSttModelUiState({ model: DOWNLOADING_MODEL, downloading: true, error: 'boom' }),
    ).toBe('downloading');
  });

  it('maps the presentation state onto the frozen data-state vocabulary', () => {
    expect(sttModelRowDataState('not-checked')).toBe('not-checked');
    expect(sttModelRowDataState('downloading')).toBe('downloading');
    expect(sttModelRowDataState('ready')).toBe('installed');
    expect(sttModelRowDataState('error')).toBe('error');
    expect(sttModelRowDataState('not-installed')).toBe('missing');
    expect(sttModelRowDataState('interrupted')).toBe('missing');
  });

  it('aggregates bytes and formats them', () => {
    const totals = aggregateBytes(DOWNLOADING_MODEL.files);
    expect(totals.downloaded).toBe(125);
    expect(totals.expected).toBe(200);
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('curates the engine error copy (never a raw IPC string)', () => {
    expect(voiceErrorCopyFor('permissionDenied')).toMatch(/Windows Settings/);
    expect(voiceErrorCopyFor('noDevice')).toMatch(/Connect a microphone/);
    expect(voiceErrorCopyFor('modelCorrupt')).toMatch(/Re-download/);
    expect(voiceErrorCopyFor(null)).toMatch(/unexpected problem/);
    // #2882 ST-7 re-pinned (G-125): the `disabled` copy points at the new enable
    // label and never names Ctrl+Space as the dictation shortcut.
    expect(voiceErrorCopyFor('disabled')).toBe(VOICE_DISABLED_ERROR_TEXT);
    expect(voiceErrorCopyFor('disabled')).not.toMatch(/Ctrl\+Space/);
  });

  it('derives the device sub-states (vanished is never a silent switch)', () => {
    const vanished = deriveDeviceRowView({
      probe: deviceProbe({ state: 'vanished', selectedId: 'Gone' }),
      selectedId: 'Gone',
      deviceCount: 2,
    });
    expect(vanished.state).toBe('vanished');
    expect(vanished.warning).toBe(true);
    expect(vanished.help).toMatch(/never switches devices/i);
    // A persisted id absent from the enumeration is vanished even when the probe
    // still reports `devices` — derivable from the persisted context value.
    expect(
      deriveDeviceRowView({
        probe: deviceProbe(),
        selectedId: 'Gone',
        deviceCount: 2,
      }).state,
    ).toBe('vanished');
    expect(
      deriveDeviceRowView({
        probe: deviceProbe({ state: 'no-device', devices: [] }),
        selectedId: null,
        deviceCount: 0,
      }).state,
    ).toBe('no-device');
    expect(
      deriveDeviceRowView({
        probe: deviceProbe({ state: 'permissionDenied' }),
        selectedId: null,
        deviceCount: 2,
      }).state,
    ).toBe('permission-denied');
  });
});

// ── C0 — speech handling (#2897 ST-1 / REQ-1) ────────────────────────────────

describe('VoiceInputSettings — C0 speech handling (#2897 ST-1)', () => {
  it('defaults to Local transcription and renders the closed two-member option set', () => {
    renderSettings();

    const row = screen.getByTestId('companion-voice-handling-row');
    expect(row).toBeInTheDocument();

    const select = screen.getByTestId('companion-voice-handling-select') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe(DEFAULT_VOICE_HANDLING);
    expect(select.value).toBe('local');

    const options = within(select).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(within(select).getByRole('option', { name: 'Local transcription' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Model audio' })).toBeInTheDocument();

    // Accessibility: labelled combobox, help bound through `aria-describedby`.
    expect(select).toHaveAccessibleName('Speech handling');
    const help = screen.getByTestId('companion-voice-handling-help');
    expect(help).toHaveAttribute('id', 'companion-voice-handling-help');
    expect(select).toHaveAttribute('aria-describedby', 'companion-voice-handling-help');
    // The default help describes the shipped local path and its transcript.
    expect(help).toHaveTextContent(/Words appear in the launcher bar/);

    // No key is written until the user changes the value.
    expect(localStorage.getItem(VOICE_HANDLING_SETTING_KEY)).toBeNull();
  });

  it('selecting Model audio persists immediately, flips the help, and announces — with no transcript claim', async () => {
    renderSettings();

    const select = screen.getByTestId('companion-voice-handling-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'model' } });

    await waitFor(() => {
      expect(localStorage.getItem(VOICE_HANDLING_SETTING_KEY)).toBe('model');
    });
    expect(select.value).toBe('model');

    // The help MUST state that model audio shows no transcript.
    await waitFor(() => {
      expect(screen.getByTestId('companion-voice-handling-help')).toHaveTextContent(
        /no words are shown/,
      );
    });

    expect(screen.getByTestId('companion-voice-settings-announcer')).toHaveTextContent(
      'Speech handling set to Model audio — no words will be shown.',
    );
  });

  it('an unknown stored raw heals to Local transcription', async () => {
    localStorage.setItem(VOICE_HANDLING_SETTING_KEY, 'telepathy');
    renderSettings();

    const select = (await screen.findByTestId(
      'companion-voice-handling-select',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe('local');
    });
    expect(screen.getByTestId('companion-voice-handling-help')).toHaveTextContent(
      /Words appear in the launcher bar/,
    );
  });

  it('a persisted Model audio value loads as-is across a remount', async () => {
    localStorage.setItem(VOICE_HANDLING_SETTING_KEY, 'model');
    renderSettings();

    const select = (await screen.findByTestId(
      'companion-voice-handling-select',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe('model');
    });
  });
});

// ── C1 — master enable (R-1.1 / DR-2) ────────────────────────────────────────

describe('VoiceInputSettings — C1 enable switch (#2877 ST-4)', () => {
  it('renders the re-pinned label + help and defaults OFF (opt-in)', async () => {
    renderSettings();

    // #2882 ST-7 re-pinned (G-125): the label no longer promises the retired
    // Ctrl+Space dictation shortcut — it teaches the hold-Space gesture.
    expect(screen.getByText(VOICE_ENABLE_LABEL)).toBeInTheDocument();
    expect(screen.queryByText('Dictate with Ctrl+Space')).toBeNull();
    // The help copy carries the shipped gesture only (bar cue + Enter + autosend),
    // and frames Ctrl+Space as the bar-opening chord — never dictation.
    const help = screen.getByText(VOICE_ENABLE_HELP_TEXT);
    expect(help).toBeInTheDocument();
    expect(help).toHaveAttribute('id', 'companion-voice-enable-help');
    const toggle = screen.getByLabelText('Enable voice input');
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem(VOICE_ENABLED_SETTING_KEY)).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    await waitFor(() => {
      expect(localStorage.getItem(VOICE_ENABLED_SETTING_KEY)).toBe('true');
    });
  });

  it('toggling OFF while listening stops the session and releases the mic', async () => {
    localStorage.setItem(VOICE_ENABLED_SETTING_KEY, 'true');
    const invoke = vi.fn(async () => undefined);
    adapterBridge.setInvoke(invoke);

    renderSettings();

    const toggle = await screen.findByLabelText('Enable voice input');
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    // Wait for the stt:state subscription to register.
    await waitFor(() => {
      expect(listenHandlers.get('stt:state')?.length ?? 0).toBeGreaterThan(0);
    });

    emitEvent('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });

    await waitFor(() => {
      expect(screen.getByTestId('companion-voice-engine-status')).toHaveAttribute(
        'data-state',
        'listening',
      );
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('stt_stop', undefined);
    });
    expect(toggle).not.toBeChecked();
  });

  it('shows the engine state: idle by default, error with curated detail', async () => {
    renderSettings();
    expect(screen.getByTestId('companion-voice-engine-status')).toHaveAttribute(
      'data-state',
      'idle',
    );
    expect(screen.getByTestId('companion-voice-engine-status')).toHaveTextContent(
      VOICE_ENGINE_NAME,
    );

    await waitFor(() => {
      expect(listenHandlers.get('stt:state')?.length ?? 0).toBeGreaterThan(0);
    });
    emitEvent('stt:state', {
      listening: false,
      code: 'permissionDenied',
      detail: 'GetUserMedia denied',
      origin: null,
    });

    await waitFor(() => {
      expect(screen.getByTestId('companion-voice-engine-status')).toHaveAttribute(
        'data-state',
        'error',
      );
    });
    expect(screen.getByTestId('companion-voice-engine-status')).toHaveTextContent(
      /Windows Settings/,
    );
    // The raw backend detail is demoted, never the primary sentence.
    expect(screen.getByTestId('companion-voice-engine-status')).not.toHaveTextContent(
      'GetUserMedia denied',
    );
  });
});

// ── C2 — model row (DR-3 / R-2.1–R-2.5 / R-5.2) ──────────────────────────────

describe('VoiceInputSettings — C2 model row (#2877 ST-4)', () => {
  it('not-checked: renders the backend-unavailable caption with the action disabled', () => {
    renderSettings({ sttModel: null });
    expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
      'data-state',
      'not-checked',
    );
    expect(screen.getByTestId('companion-voice-model-status')).toHaveTextContent(
      'Not checked — the Fredo backend is unavailable.',
    );
    expect(screen.getByTestId('companion-voice-model-download')).toBeDisabled();
    expect(screen.getByTestId('companion-voice-model-recheck')).toBeEnabled();
  });

  it('not-installed: names the shortfall and offers ONE primary Download action', () => {
    const onDownloadModel = vi.fn();
    renderSettings({ sttModel: NOT_INSTALLED_MODEL, onDownloadModel });
    expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
      'data-state',
      'missing',
    );
    expect(screen.getByTestId('companion-voice-model-status')).toHaveTextContent(
      'Voice input model not installed — 0 of 4 files. Choose Download voice model.',
    );
    const action = screen.getByTestId('companion-voice-model-download');
    expect(action).toBeEnabled();
    expect(action).toHaveTextContent('Download voice model');
    fireEvent.click(action);
    expect(onDownloadModel).toHaveBeenCalledTimes(1);
  });

  it('downloading: busy/disabled action + aggregate determinate progress', () => {
    renderSettings({ sttModel: DOWNLOADING_MODEL, sttDownloading: true });
    expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
      'data-state',
      'downloading',
    );
    const action = screen.getByTestId('companion-voice-model-download');
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveTextContent('Downloading…');
    expect(screen.getByTestId('companion-voice-model-progress')).toBeInTheDocument();
    const bar = within(screen.getByTestId('companion-voice-model-progress')).getByRole(
      'progressbar',
    );
    expect(bar).toHaveAccessibleName('Voice input model download progress');
    expect(bar).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Voice input model download'),
    );
  });

  it('ready: installed caption (success), location shown, action disabled', () => {
    renderSettings({ sttModel: READY_MODEL });
    expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
      'data-state',
      'installed',
    );
    const caption = screen.getByTestId('companion-voice-model-status');
    expect(caption).toHaveTextContent('Voice input model installed.');
    expect(screen.getByTestId('companion-voice-model-location')).toHaveTextContent(
      'C:\\models\\stt',
    );
    expect(screen.getByTestId('companion-voice-model-download')).toBeDisabled();
    expect(screen.getByTestId('companion-voice-model-download')).toHaveTextContent('Installed');
  });

  it('error: curated role="alert" primary + demoted raw detail + location + Re-download', () => {
    renderSettings({ sttModel: ERROR_MODEL });
    expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
      'data-state',
      'error',
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Not enough disk space');
    expect(alert).not.toHaveTextContent('disk full');
    // Raw backend detail is demoted to a labelled mono line.
    expect(screen.getByText(/Technical details: disk full/)).toBeInTheDocument();
    // AC2 — the resolved location is shown on error too.
    expect(screen.getByTestId('companion-voice-model-location')).toHaveTextContent(
      'C:\\models\\stt',
    );
    expect(screen.getByTestId('companion-voice-model-download')).toHaveTextContent(
      'Re-download voice model',
    );
  });

  it('interrupted: resume caption (warning tint) + Resume download action', () => {
    const onDownloadModel = vi.fn();
    renderSettings({ sttModel: INTERRUPTED_MODEL, onDownloadModel });
    expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
      'data-state',
      'missing',
    );
    expect(screen.getByTestId('companion-voice-model-status')).toHaveTextContent(
      /Interrupted — .* Choose Download to resume\./,
    );
    const action = screen.getByTestId('companion-voice-model-download');
    expect(action).toHaveTextContent('Resume download');
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(onDownloadModel).toHaveBeenCalledTimes(1);
  });

  it('error triggered by a failed action surfaces the curated message on the alert caption', () => {
    renderSettings({
      sttModel: NOT_INSTALLED_MODEL,
      sttError:
        'The download lost its connection. Check your network connection, then choose Retry.',
    });
    expect(screen.getByTestId('companion-voice-model-row')).toHaveAttribute(
      'data-state',
      'error',
    );
    const alert = screen.getByTestId('companion-voice-model-status');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('lost its connection');
    // The alert replaces the counting caption rather than duplicating it.
    expect(screen.getByTestId('companion-voice-model-status')).not.toHaveTextContent(
      'files. Choose Download voice model.',
    );
  });

  it('Re-check invokes the re-probe callback', () => {
    const onRecheck = vi.fn();
    renderSettings({ sttModel: READY_MODEL, onRecheck });
    fireEvent.click(screen.getByTestId('companion-voice-model-recheck'));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});

// ── C3 — device selection (DR-5 / R-3.2 / R-5.1) ──────────────────────────────

describe('VoiceInputSettings — C3 device selection (#2877 ST-4)', () => {
  it('renders a chakra select with System default + enumerated devices and persists the choice', async () => {
    renderSettings({ sttDevices: deviceProbe() });

    const select = screen.getByTestId('companion-voice-device-select') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(within(select).getByRole('option', { name: 'System default' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Microphone (USB)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Iriun Webcam' })).toBeInTheDocument();
    expect(select.value).toBe('');
    expect(screen.queryByTestId('companion-voice-device-rescan')).toBeNull();

    fireEvent.change(select, { target: { value: 'Iriun Webcam' } });

    await waitFor(() => {
      expect(localStorage.getItem(VOICE_DEVICE_ID_SETTING_KEY)).toBe('Iriun Webcam');
    });
    expect(select.value).toBe('Iriun Webcam');
  });

  it('vanished: shows the warning + Re-scan and does NOT silently switch devices', async () => {
    localStorage.setItem(VOICE_DEVICE_ID_SETTING_KEY, 'Gone mic');
    renderSettings({
      sttDevices: deviceProbe({ state: 'vanished', selectedId: 'Gone mic' }),
    });

    const select = (await screen.findByTestId(
      'companion-voice-device-select',
    )) as HTMLSelectElement;
    // The persisted selection is preserved (no silent fallback to System default).
    await waitFor(() => {
      expect(select.value).toBe('Gone mic');
    });
    expect(within(select).getByRole('option', { name: /Gone mic — not available/ })).toBeDisabled();
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /isn't available/,
    );
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /never switches devices on its own/,
    );
    expect(screen.getByTestId('companion-voice-device-rescan')).toBeInTheDocument();
  });

  it('no-device: disables the selector and names the next step', () => {
    renderSettings({
      sttDevices: deviceProbe({ state: 'no-device', devices: [], selectedId: null }),
    });
    expect(screen.getByTestId('companion-voice-device-select')).toBeDisabled();
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /No microphone found/,
    );
    expect(screen.getByTestId('companion-voice-device-rescan')).toBeInTheDocument();
  });

  it('permission-denied: actionable privacy-settings copy + Re-scan', () => {
    renderSettings({ sttDevices: deviceProbe({ state: 'permissionDenied' }) });
    expect(screen.getByTestId('companion-voice-device-row')).toHaveTextContent(
      /Windows Settings → Privacy → Microphone/,
    );
    expect(screen.getByTestId('companion-voice-device-rescan')).toBeInTheDocument();
  });

  it('checking: disables the selector while the enumeration is in flight', () => {
    renderSettings({
      sttDevices: deviceProbe({ state: 'checking', devices: [], selectedId: null }),
    });
    expect(screen.getByTestId('companion-voice-device-select')).toBeDisabled();
    expect(
      within(screen.getByTestId('companion-voice-device-select')).getByRole('option', {
        name: 'Checking microphones…',
      }),
    ).toBeInTheDocument();
  });

  it('Re-scan invokes the device re-probe callback', () => {
    const onRescanDevices = vi.fn();
    renderSettings({
      sttDevices: deviceProbe({ state: 'no-device', devices: [], selectedId: null }),
      onRescanDevices,
    });
    fireEvent.click(screen.getByTestId('companion-voice-device-rescan'));
    expect(onRescanDevices).toHaveBeenCalledTimes(1);
  });
});

// ── C4 — autosend (DR-6 / R-1.2) ─────────────────────────────────────────────

describe('VoiceInputSettings — C4 autosend (#2877 ST-4)', () => {
  it('defaults OFF with the review caption and persists ON with the flipped caption', async () => {
    renderSettings();

    expect(screen.getByText('Send transcripts automatically')).toBeInTheDocument();
    const toggle = screen.getByTestId('companion-voice-autosend');
    expect(screen.getByLabelText('Send voice transcripts automatically')).not.toBeChecked();
    expect(
      screen.getByText('Transcripts appear in the launcher bar for review before you send.'),
    ).toBeInTheDocument();
    expect(localStorage.getItem(VOICE_AUTOSEND_SETTING_KEY)).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    await waitFor(() => {
      expect(
        screen.getByText('Transcripts are sent as soon as you stop — no review.'),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(localStorage.getItem(VOICE_AUTOSEND_SETTING_KEY)).toBe('true');
    });
  });
});

// ── C0r — model audio status (#2897 ST-6 / REQ-7) ────────────────────────────

describe('VoiceInputSettings — C0r model audio status (#2897 ST-6)', () => {
  const setHandling = (value: 'local' | 'model') =>
    localStorage.setItem(VOICE_HANDLING_SETTING_KEY, value);

  const installCapability = (result: unknown) => {
    adapterBridge.setInvoke((async (command: string) =>
      command === 'stt_audio_capability' ? result : undefined) as never);
  };

  const capabilityRow = () => screen.getByTestId('companion-voice-model-audio-row');
  const capabilityStatus = () => screen.getByTestId('companion-voice-model-audio-status');

  it('is NOT rendered while the method is Local transcription', () => {
    renderSettings();
    expect(screen.queryByTestId('companion-voice-model-audio-row')).toBeNull();
  });

  it('checking: renders the in-flight sentence and no action', async () => {
    setHandling('model');
    // A capability probe that never settles keeps the UI-side `checking` state
    // observable; every other command resolves so the persisted mode still loads.
    adapterBridge.setInvoke((async (command: string) => {
      if (command === 'stt_audio_capability') return new Promise(() => {});
      return undefined;
    }) as never);
    renderSettings();
    await waitFor(() =>
      expect(
        (screen.getByTestId('companion-voice-handling-select') as HTMLSelectElement).value,
      ).toBe('model'),
    );
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'checking'));
    expect(capabilityStatus()).toHaveTextContent(
      "Checking the companion model's audio support…",
    );
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-audio-change-model')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-audio-retry')).toBeNull();
  });

  it('ready: names the reported model and offers no action', async () => {
    setHandling('model');
    installCapability({
      state: 'ready',
      model: 'Gemma-4-E2B',
      limitMs: null,
      code: null,
      detail: null,
    });
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'ready'));
    expect(capabilityStatus()).toHaveTextContent(
      'Gemma-4-E2B can interpret audio. Recordings stay on this machine.',
    );
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
    expect(screen.queryByTestId('companion-voice-model-audio-retry')).toBeNull();
  });

  it('unsupported: warns, offers local + change model, and one click flips the persisted setting', async () => {
    setHandling('model');
    installCapability({
      state: 'unsupported',
      model: 'Gemma-4-E2B',
      limitMs: null,
      code: 'modelAudioUnsupported',
      detail: 'HTTP 400: unsupported content part',
    });
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'unsupported'));
    expect(capabilityStatus()).toHaveTextContent(
      "The installed companion model can't interpret audio. Recordings won't be sent.",
    );
    // The raw backend detail is demoted, never the primary sentence.
    expect(capabilityRow()).toHaveTextContent(/Technical details: HTTP 400/);
    expect(screen.getByTestId('companion-voice-model-audio-change-model')).toHaveTextContent(
      'Change model',
    );

    fireEvent.click(screen.getByTestId('companion-voice-model-audio-use-local'));

    await waitFor(() => {
      expect(localStorage.getItem(VOICE_HANDLING_SETTING_KEY)).toBe('local');
    });
    expect(screen.getByTestId('companion-voice-settings-announcer')).toHaveTextContent(
      'Speech handling set to Local transcription.',
    );
    // The mode flipped, so the model-audio row is gone.
    expect(screen.queryByTestId('companion-voice-model-audio-row')).toBeNull();
  });

  it('server-unavailable: warns and Try again re-probes + announces', async () => {
    setHandling('model');
    const invoke = vi.fn(async (command: string) =>
      command === 'stt_audio_capability'
        ? {
            state: 'serverUnavailable',
            model: null,
            limitMs: null,
            code: 'modelAudioUnavailable',
            detail: 'connection refused',
          }
        : undefined,
    );
    adapterBridge.setInvoke(invoke as never);
    renderSettings();
    await waitFor(() =>
      expect(capabilityRow()).toHaveAttribute('data-state', 'server-unavailable'),
    );
    expect(capabilityStatus()).toHaveTextContent(
      "The local model server isn't running, so Fredo can't interpret audio.",
    );

    const probes = () =>
      invoke.mock.calls.filter((call) => call[0] === 'stt_audio_capability').length;
    const before = probes();
    fireEvent.click(screen.getByTestId('companion-voice-model-audio-retry'));
    await waitFor(() => {
      expect(probes()).toBeGreaterThan(before);
    });
    expect(screen.getByTestId('companion-voice-settings-announcer')).toHaveTextContent(
      "Checking the companion model's audio support again.",
    );
  });

  it('unknown: fail-closed copy + Try again + the demoted detail', async () => {
    setHandling('model');
    installCapability({
      state: 'unknown',
      model: null,
      limitMs: null,
      code: null,
      detail: 'HTTP 500',
    });
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'unknown'));
    expect(capabilityStatus()).toHaveTextContent("Can't check audio support right now.");
    expect(capabilityRow()).toHaveTextContent(/Technical details: HTTP 500/);
    expect(screen.getByTestId('companion-voice-model-audio-retry')).toBeInTheDocument();
    // `unknown` never offers the mode switch — there is nothing proven to degrade.
    expect(screen.queryByTestId('companion-voice-model-audio-use-local')).toBeNull();
  });

  it('a rejected / malformed probe is `unknown`, never `ready`', async () => {
    setHandling('model');
    adapterBridge.setInvoke((async (command: string) => {
      if (command === 'stt_audio_capability') throw new Error('command unavailable');
      return undefined;
    }) as never);
    renderSettings();
    await waitFor(() => expect(capabilityRow()).toHaveAttribute('data-state', 'unknown'));
  });
});

// ── DR-10 — settings live region ─────────────────────────────────────────────

describe('VoiceInputSettings — DR-10 live region (#2877 ST-4)', () => {
  it('renders one persistent polite live region that announces settings changes', async () => {
    renderSettings();

    const announcer = screen.getByTestId('companion-voice-settings-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(screen.getByLabelText('Enable voice input'));
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Voice input is on.');
    });

    fireEvent.click(screen.getByLabelText('Send voice transcripts automatically'));
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Transcripts will be sent automatically.');
    });
  });
});

// ── DR-12 — token / geometry source pins ─────────────────────────────────────

describe('VoiceInputSettings — DR-12 token + geometry pins (#2877 ST-4)', () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      'src/shared/components/companion/VoiceInputSettings.tsx',
    ),
    'utf8',
  );

  it('never alpha-appends onto a var() — every alpha goes through tint()', () => {
    expect(source).not.toMatch(/var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/);
    expect(source).toContain('tint(');
  });

  it('uses chakra.select (never NativeSelect) with theme CSS-var props', () => {
    expect(source).not.toMatch(/<NativeSelect|NativeSelect\./);
    expect(source).toContain('chakra.select');
    expect(source).toContain('bg="var(--card-bg)"');
    expect(source).toContain('borderColor="var(--border-color)"');
    expect(source).toContain('height="32px"');
    expect(source).toContain('maxWidth="260px"');
  });

  it('states geometry as CSS unit strings (never a bare numeric size prop)', () => {
    expect(source).toContain('width="1px"');
    expect(source).toContain('height="1px"');
    expect(source).not.toMatch(/boxSize=\{?\d/);
  });
});
