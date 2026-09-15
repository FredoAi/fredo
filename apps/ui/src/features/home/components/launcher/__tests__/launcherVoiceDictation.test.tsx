/**
 * Spec #2877 ST-5 — launcher voice dictation: the binding context-dependent
 * Ctrl+Space cascade + the launcher-origin listening cue (DR-7/DR-9/DR-10/DR-11).
 *
 * Pins:
 *   1. `selectCtrlSpaceAction` — the binding cascade: the #2823 AC3 carve-out
 *      runs first; the DR-9 disabled gate; companion-away pre-empts bar-focused;
 *      else `open` WITHOUT listening.
 *   2. `voiceStartErrorCopy` — curated, actionable copy per typed failure code.
 *   3. The document listener wiring: bar-focused → launcher listening;
 *      companion-away → companion listening; default → open (no listen).
 *   4. Escape cancels a live dictation session BEFORE the launcher close.
 *   5. The EXISTING bar input value tracks the live transcript (never submits).
 *   6. DR-9: with voice disabled no listening branch is reachable (`stt_start`
 *      is never invoked) and disabling mid-session stops the session.
 *   7. DR-7: the FROZEN static dot + the `Listening` chip + the Stop control +
 *      the `Listening…` placeholder + the hearing-nothing hint + the alert.
 *   8. R-5.3: exactly one indicator — the bar cue is launcher-origin only.
 *   9. DR-10: persistent announcers — start/stop transitions once; the newest
 *      FINAL segment only (partials never announce).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { FredoFeatureClass } from '@/shared/classes/FredoFeatureClass';
import { HEARING_NOTHING_COPY, HEARING_NOTHING_MS } from '../LauncherCommandBar';
import {
  LauncherShell,
  selectCtrlSpaceAction,
  voiceStartErrorCopy,
  type CtrlSpaceContext,
} from '../LauncherShell';

// LauncherShell reads the live connection flag via useConnectionStatus (no
// StreamProvider in this isolated harness) — stub the one consumer.
vi.mock('@/shared/contexts/StreamContext', () => ({
  useConnectionStatus: () => ({ isConnected: true }),
}));

// Companion presence + the DR-9 voice-enablement flag are host-derived from
// `useCompanion`; a hoisted mutable object lets each case pick seated / away /
// off / voice-disabled without re-mocking the module.
const companionMock = vi.hoisted(() => ({
  current: {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    // #2878 ST-1 — the persisted autosend preference the finalize effect consumes
    // (DEFAULT false).
    voiceAutosend: false,
  },
}));
vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => companionMock.current,
}));

// #2878 ST-1 — the ONE dispatch path (`askActiveCompanion`) is spied so the
// commit contract (launch vs send vs no-op) is observable without mounting the
// real entity. `CompanionEntity` is stubbed (the seat render is irrelevant here).
const companionDispatchMock = vi.hoisted(() => ({
  askActiveCompanion: vi.fn((_text: string) => true),
}));
vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: () => null,
  askActiveCompanion: companionDispatchMock.askActiveCompanion,
}));

type Handler = (payload: unknown) => void;

let handlers: Record<string, Handler[]>;
let invokeSpy: ReturnType<typeof vi.fn>;

const emit = (event: string, payload: unknown) => {
  (handlers[event] ?? []).forEach((handler) => handler(payload));
};

function okStart() {
  return {
    started: true,
    code: null,
    detail: null,
    deviceName: 'Test Mic',
    sampleRate: 48000,
  };
}

beforeEach(() => {
  handlers = {};
  invokeSpy = vi.fn(async (command: string) => (command === 'stt_start' ? okStart() : undefined));
  adapterBridge.setInvoke(invokeSpy as never);
  adapterBridge.setListen((async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    return () => {};
  }) as never);
  companionMock.current = {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    voiceAutosend: false,
  };
  companionDispatchMock.askActiveCompanion.mockReset();
  companionDispatchMock.askActiveCompanion.mockReturnValue(true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── 1. Pure cascade ──────────────────────────────────────────────────────────

describe('selectCtrlSpaceAction — binding Ctrl+Space cascade (pure)', () => {
  const ctx = (over: Partial<CtrlSpaceContext>): CtrlSpaceContext => ({
    activeIsTextControl: false,
    activeInLauncher: false,
    listening: false,
    companionAway: false,
    voiceEnabled: true,
    ...over,
  });

  it('suppresses the chord while typing in a text control OUTSIDE the launcher (carve-out first)', () => {
    expect(
      selectCtrlSpaceAction(ctx({ activeIsTextControl: true, activeInLauncher: false })),
    ).toBe('pass');
  });

  it('does NOT suppress when the text control IS the launcher bar', () => {
    expect(
      selectCtrlSpaceAction(
        ctx({ activeIsTextControl: true, activeInLauncher: true, listening: false }),
      ),
    ).toBe('launcher-listen');
  });

  it('companion-away (case 1) pre-empts the bar-focused branch (case 2)', () => {
    expect(
      selectCtrlSpaceAction(
        ctx({ activeIsTextControl: false, activeInLauncher: true, companionAway: true }),
      ),
    ).toBe('companion-listen');
  });

  it('bar-focused (case 2) starts listening when idle', () => {
    expect(selectCtrlSpaceAction(ctx({ activeInLauncher: true, listening: false }))).toBe(
      'launcher-listen',
    );
  });

  it('bar-focused while listening cancels the session', () => {
    expect(selectCtrlSpaceAction(ctx({ activeInLauncher: true, listening: true }))).toBe(
      'launcher-cancel',
    );
  });

  it('default (case 3) opens the bar and NEVER starts listening', () => {
    expect(selectCtrlSpaceAction(ctx({}))).toBe('open');
  });

  it('a seated companion + focused bar takes case 2, never case 1', () => {
    // `companionAway` false = seated → branch 1 cannot fire.
    expect(selectCtrlSpaceAction(ctx({ activeInLauncher: true, companionAway: false }))).toBe(
      'launcher-listen',
    );
  });

  // ── DR-9 — the disabled gate ───────────────────────────────────────────────

  it('DR-9: with voice disabled the carve-out still passes (never acts)', () => {
    expect(
      selectCtrlSpaceAction(ctx({ voiceEnabled: false, activeIsTextControl: true })),
    ).toBe('pass');
  });

  it('DR-9: with voice disabled a focused bar falls through to open (never listen/cancel)', () => {
    expect(
      selectCtrlSpaceAction(ctx({ voiceEnabled: false, activeInLauncher: true, listening: false })),
    ).toBe('open');
    expect(
      selectCtrlSpaceAction(ctx({ voiceEnabled: false, activeInLauncher: true, listening: true })),
    ).toBe('open');
  });

  it('DR-9: with voice disabled a companion-away chord opens the bar (never companion-listen)', () => {
    expect(selectCtrlSpaceAction(ctx({ voiceEnabled: false, companionAway: true }))).toBe('open');
  });
});

// ── 2. Curated start-failure copy ────────────────────────────────────────────

describe('voiceStartErrorCopy — DR-11 curated start-failure copy', () => {
  it('maps every typed failure code to actionable copy, never the raw code', () => {
    for (const code of [
      'permissionDenied',
      'noDevice',
      'modelMissing',
      'modelCorrupt',
      'engineStartFailed',
    ]) {
      const copy = voiceStartErrorCopy(code);
      expect(copy).toBeTruthy();
      expect(copy).not.toContain(code);
    }
  });

  it('names the microphone cause + next step for a denied permission', () => {
    expect(voiceStartErrorCopy('permissionDenied')).toMatch(/Microphone/);
  });

  it('points at Companion settings when the model is not ready', () => {
    expect(voiceStartErrorCopy('modelMissing')).toMatch(/Companion settings/);
    expect(voiceStartErrorCopy('modelCorrupt')).toMatch(/Companion settings/);
  });

  it('is null when there is no failure code', () => {
    expect(voiceStartErrorCopy(null)).toBeNull();
    expect(voiceStartErrorCopy('somethingUnknown')).toBeNull();
  });
});

// ── 3-9. LauncherShell wiring ────────────────────────────────────────────────

describe('LauncherShell — Ctrl+Space / Escape / live transcript wiring', () => {
  const renderShell = (onOpenFeature = vi.fn()) => {
    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={onOpenFeature} />);
    return onOpenFeature;
  };

  const ctrlSpace = () => {
    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });
  };

  const focusBar = () => {
    const input = screen.getByRole('searchbox');
    act(() => {
      input.focus();
      fireEvent.focus(input);
    });
    return input;
  };

  const emitListening = (listening: boolean, origin: string | null) =>
    act(() => {
      emit('stt:state', { listening, code: null, detail: null, origin });
    });

  it('case 2: Ctrl+Space with the bar focused starts a LAUNCHER session', () => {
    renderShell();
    focusBar();

    ctrlSpace();

    expect(invokeSpy).toHaveBeenCalledWith('stt_start', { origin: 'launcher' });
  });

  it('case 1: Ctrl+Space with the companion away starts a COMPANION session', () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: true,
      isAutoHidden: false,
      isInUse: false,
    };
    renderShell();

    ctrlSpace();

    expect(invokeSpy).toHaveBeenCalledWith('stt_start', { origin: 'companion' });
  });

  it('case 3: default Ctrl+Space opens the bar and does NOT start listening', () => {
    renderShell();

    ctrlSpace();

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
  });

  it('Escape cancels a live session BEFORE closing the launcher', () => {
    renderShell();
    emitListening(true, 'launcher');
    const input = focusBar();

    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
  });

  it('F-38: a duplicate companion-away Ctrl+Space keeps the live session (Escape still cancels, no alert)', async () => {
    // Tester repro (F-38): companion away ⇒ `selectCtrlSpaceAction` returns
    // `companion-listen` REGARDLESS of `listening`, so a second Ctrl+Space
    // re-invokes `stt_start`. The duplicate must be an idempotent no-op: the
    // live session survives (so Escape still cancels it) and no failure surface
    // renders (alreadyListening is not an error).
    companionMock.current.state = {
      isVisible: true,
      isAway: true,
      isAutoHidden: false,
      isInUse: false,
    };
    let startCount = 0;
    invokeSpy.mockImplementation(async (command: string) => {
      if (command === 'stt_start') {
        startCount += 1;
        return startCount === 1
          ? okStart()
          : {
              started: false,
              code: 'alreadyListening',
              detail: 'A listening session is already active.',
              deviceName: null,
              sampleRate: null,
            };
      }
      return undefined;
    });
    renderShell();

    // Press 1 — a normal companion-origin start.
    await act(async () => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
      await Promise.resolve();
    });
    expect(invokeSpy).toHaveBeenCalledWith('stt_start', { origin: 'companion' });

    // The app-global live state (as the backend emits it after a real start).
    emitListening(true, 'companion');

    // Press 2 — same chord, backend now reports alreadyListening.
    await act(async () => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
      await Promise.resolve();
    });

    const startCalls = invokeSpy.mock.calls.filter((call) => call[0] === 'stt_start');
    expect(startCalls).toHaveLength(2);
    expect(startCalls.every((call) => call[1]?.origin === 'companion')).toBe(true);

    // The session is still live: Escape cancels it (never a launcher close).
    const input = focusBar();
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);

    // No inline failure surface (`voiceErrorMessage` must be null).
    expect(screen.queryByTestId('launcher-command-listening-status')).toBeNull();
  });

  it('the bar input tracks the live transcript (partial → partial → final) and never submits', () => {
    const onOpenFeature = renderShell();

    emitListening(true, 'launcher');
    const input = screen.getByRole('searchbox') as HTMLInputElement;

    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision: 1,
        segmentId: 0,
        text: 'hello',
        isFinal: false,
        latencyMs: 4,
      });
    });
    expect(input.value).toBe('hello');

    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision: 2,
        segmentId: 0,
        text: 'hello world',
        isFinal: false,
        latencyMs: 6,
      });
    });
    expect(input.value).toBe('hello world');

    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision: 3,
        segmentId: 0,
        text: 'hello world',
        isFinal: true,
        latencyMs: 7,
      });
    });
    // Final commits the segment; the text REMAINS in the input (no submit).
    expect(input.value).toBe('hello world');
    expect(onOpenFeature).not.toHaveBeenCalled();
  });

  it('the DR-1 listening cue appears only while listening', () => {
    renderShell();

    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();

    emitListening(true, 'launcher');
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
  });

  // ── DR-9 — the cascade respects voiceEnabled ───────────────────────────────

  it('DR-9: with voice disabled Ctrl+Space opens and NEVER starts listening', () => {
    companionMock.current.voiceEnabled = false;
    renderShell();
    focusBar();

    ctrlSpace();

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
  });

  it('DR-9: with voice disabled a companion-away chord never starts a companion session', () => {
    companionMock.current.voiceEnabled = false;
    companionMock.current.state = {
      isVisible: true,
      isAway: true,
      isAutoHidden: false,
      isInUse: false,
    };
    renderShell();

    ctrlSpace();

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
  });

  it('DR-9: disabling voice mid-session stops the session and announces it', async () => {
    renderShell();
    emitListening(true, 'launcher');
    expect(screen.getByTestId('voice-listening-announcer')).toHaveTextContent('Listening');

    // Flip the persisted preference and force a re-render via a transcript tick.
    companionMock.current.voiceEnabled = false;
    await act(async () => {
      emit('stt:transcript', {
        sessionId: 's',
        revision: 1,
        segmentId: 0,
        text: 'x',
        isFinal: false,
        latencyMs: 1,
      });
      await Promise.resolve();
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    expect(screen.getByTestId('voice-listening-announcer')).toHaveTextContent('Voice input is off');
  });

  // ── DR-7 — the listening cue ───────────────────────────────────────────────

  it('DR-7: the frozen dot, the Listening chip and the Stop control render while listening', () => {
    renderShell();
    emitListening(true, 'launcher');

    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-command-listening-chip')).toHaveTextContent('Listening');
    const stop = screen.getByTestId('launcher-command-listening-stop');
    expect(stop).toHaveAttribute('aria-label', 'Stop listening');
  });

  it('DR-7: the Stop control invokes stt_stop', () => {
    renderShell();
    emitListening(true, 'launcher');

    act(() => {
      fireEvent.click(screen.getByTestId('launcher-command-listening-stop'));
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
  });

  it('DR-7: the placeholder switches to Listening… while listening', () => {
    renderShell();
    const input = screen.getByRole('searchbox');
    expect(input).toHaveAttribute('placeholder', 'search or command');

    emitListening(true, 'launcher');
    expect(input).toHaveAttribute('placeholder', 'Listening…');
  });

  it('DR-7: the hearing-nothing hint appears after HEARING_NOTHING_MS of silence', () => {
    vi.useFakeTimers();
    renderShell();
    emitListening(true, 'launcher');
    expect(screen.queryByTestId('launcher-command-listening-status')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(HEARING_NOTHING_MS);
    });

    expect(screen.getByTestId('launcher-command-listening-status')).toHaveTextContent(
      HEARING_NOTHING_COPY,
    );
  });

  it('DR-7: the hearing-nothing hint never appears once text arrives', () => {
    vi.useFakeTimers();
    renderShell();
    emitListening(true, 'launcher');
    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision: 1,
        segmentId: 0,
        text: 'hi there',
        isFinal: false,
        latencyMs: 1,
      });
    });

    act(() => {
      vi.advanceTimersByTime(HEARING_NOTHING_MS);
    });

    expect(screen.queryByTestId('launcher-command-listening-status')).toBeNull();
  });

  it('DR-11: a failed start renders an inline role=alert with curated copy', async () => {
    invokeSpy.mockImplementation(async (command: string) =>
      command === 'stt_start'
        ? { started: false, code: 'modelMissing', detail: 'raw ipc string', deviceName: null, sampleRate: null }
        : undefined,
    );
    renderShell();
    focusBar();

    await act(async () => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
      await Promise.resolve();
    });

    const status = await screen.findByTestId('launcher-command-listening-status');
    expect(status).toHaveAttribute('role', 'alert');
    expect(status).toHaveTextContent("Voice input model isn't ready");
    expect(status).not.toHaveTextContent('raw ipc string');
  });

  // ── R-5.3 — exactly one indicator, routed by origin ─────────────────────────

  it('R-5.3: a launcher-origin session shows the bar cue', () => {
    renderShell();
    emitListening(true, 'launcher');

    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-command-listening-chip')).toBeInTheDocument();
  });

  it('R-5.3: a companion-origin session shows NO bar cue (the bubble owns it)', () => {
    renderShell();
    emitListening(true, 'companion');

    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
  });

  // ── DR-10 — persistent announcers ──────────────────────────────────────────

  it('DR-10: the listening announcer flips once per transition', () => {
    renderShell();
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('');

    emitListening(true, 'launcher');
    expect(announcer).toHaveTextContent('Listening');

    emitListening(false, 'launcher');
    expect(announcer).toHaveTextContent('Stopped listening');
  });

  it('DR-10: the transcript announcer carries only the newest FINAL segment', () => {
    renderShell();
    const announcer = screen.getByTestId('voice-transcript-announcer');
    emitListening(true, 'launcher');

    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision: 1,
        segmentId: 0,
        text: 'hello',
        isFinal: false,
        latencyMs: 1,
      });
    });
    // Partials NEVER announce.
    expect(announcer).toHaveTextContent('');

    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision: 2,
        segmentId: 0,
        text: 'hello world',
        isFinal: true,
        latencyMs: 2,
      });
    });
    expect(announcer).toHaveTextContent('hello world');
  });
});

// ── #2878 ST-1 — ONE commit path (Enter) + autosend-on-finalize ──────────────

describe('LauncherShell — #2878 ST-1 commit path + autosend finalize', () => {
  const FEATURE = {
    id: 'mission-monitor',
    name: 'Mission Monitor',
    icon: () => null,
  } as unknown as FredoFeatureClass;

  const renderShell = (features: FredoFeatureClass[] = [FEATURE]) => {
    const onOpenFeature = vi.fn();
    renderWithChakra(<LauncherShell showableFeatures={features} onOpenFeature={onOpenFeature} />);
    return onOpenFeature;
  };

  const input = () => screen.getByRole('searchbox') as HTMLInputElement;

  const type = (value: string) => {
    act(() => {
      fireEvent.change(input(), { target: { value } });
    });
  };

  const pressEnter = () => {
    act(() => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
  };

  const emitListening = (listening: boolean, origin: string | null) =>
    act(() => {
      emit('stt:state', { listening, code: null, detail: null, origin });
    });

  const emitFinal = (text: string, revision = 1) =>
    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision,
        segmentId: 0,
        text,
        isFinal: true,
        latencyMs: 1,
      });
    });

  const emitPartial = (text: string, revision = 1) =>
    act(() => {
      emit('stt:transcript', {
        sessionId: 's',
        revision,
        segmentId: 0,
        text,
        isFinal: false,
        latencyMs: 1,
      });
    });

  const seatCompanion = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: false,
    };
  };

  // ── Enter contract (unchanged, extended) ───────────────────────────────────

  it('Enter: an exact full-name match launches and NEVER sends (launch wins)', () => {
    seatCompanion();
    const onOpenFeature = renderShell();

    type('  mission monitor  ');
    pressEnter();

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('mission-monitor');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('Enter: a non-match with an active companion sends through askActiveCompanion and clears the bar', () => {
    seatCompanion();
    const onOpenFeature = renderShell();

    type('hello there');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('hello there');
    expect(input().value).toBe('');
    expect(onOpenFeature).not.toHaveBeenCalled();
  });

  it('Enter: a non-match with NO active companion never sends (today’s launch path)', () => {
    renderShell();

    type('hello there');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('Enter: busy is a GLOBAL no-op (no launch, no send)', () => {
    seatCompanion();
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: true,
    };
    const onOpenFeature = renderShell();

    type('hello there');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(onOpenFeature).not.toHaveBeenCalled();
  });

  // ── Autosend finalize (R-2.5) ──────────────────────────────────────────────

  it('autosend ON: finalizing an exact tile name launches once (launch wins)', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    const onOpenFeature = renderShell();

    emitListening(true, 'launcher');
    emitFinal('Mission Monitor');
    emitListening(false, 'launcher');

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('autosend ON: finalizing a non-match with an active companion sends once and clears the bar', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    emitListening(true, 'launcher');
    emitFinal('hello there');
    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledTimes(1);
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('hello there');
    expect(input().value).toBe('');
  });

  it('autosend OFF: finalizing leaves the transcript in the bar and never dispatches (R-2.6)', () => {
    seatCompanion();
    renderShell();

    emitListening(true, 'launcher');
    emitFinal('hello there');
    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('hello there');
  });

  it('autosend ON while busy: the finalize is a silent hard drop (no send, no launch, text kept)', () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: true,
    };
    companionMock.current.voiceAutosend = true;
    const onOpenFeature = renderShell();

    emitListening(true, 'launcher');
    emitFinal('hello there');
    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(input().value).toBe('hello there');
  });

  it('autosend ON: a final landing just after the state event still commits (liveText dep)', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    emitListening(true, 'launcher');
    // The state event lands FIRST with no text...
    emitListening(false, 'launcher');
    // ...then the final transcript arrives (synthetic-lever ordering).
    emitFinal('late text');

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledTimes(1);
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('late text');
  });

  it('autosend ON: commits exactly once per session (one-shot guard)', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    emitListening(true, 'launcher');
    emitFinal('once');
    emitListening(false, 'launcher');
    // A duplicate end-of-session state event and a stray final never re-dispatch.
    emitListening(false, 'launcher');
    emitFinal('once more');

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledTimes(1);
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('once');
  });

  // ── Cancel suppression + restore (R-3.1/R-3.2) ─────────────────────────────

  it('Escape cancels: suppresses autosend and restores the pre-session bar text', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    type('draft I typed');
    emitListening(true, 'launcher');
    emitPartial('hello');
    expect(input().value).toBe('hello');

    act(() => {
      fireEvent.keyDown(input(), { key: 'Escape' });
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('draft I typed');
  });

  it('the Ctrl+Space launcher-cancel cascade suppresses autosend and restores the bar', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    type('draft I typed');
    emitListening(true, 'launcher');
    emitPartial('hello');

    act(() => {
      input().focus();
      fireEvent.focus(input());
    });
    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('draft I typed');
  });

  it('the voice-disabled teardown stops the session, restores the bar, and never autosends', async () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    type('draft I typed');
    emitListening(true, 'launcher');
    emitPartial('hello');

    companionMock.current.voiceEnabled = false;
    await act(async () => {
      // A distinct partial value forces the re-render that runs the teardown effect.
      emitPartial('hello world', 2);
      await Promise.resolve();
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('draft I typed');
  });

  it('an empty finalize restores the pre-session text and never dispatches (R-5.1)', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    type('draft I typed');
    emitListening(true, 'launcher');
    // The live-text writer replaces the bar at session start...
    expect(input().value).toBe('');
    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('draft I typed');
  });

  // ── ST-1r — session-scoped finalize evidence (the round-2 defect) ──────────
  // The finalize commit is decided by the session's OWN committed FINAL, never by
  // the bar mirror. These legs FAIL on the pre-fix code (mirror-derived
  // `sessionHasTextRef`): the discriminator + the minimize repro dispatch the
  // draft, and both E-1 legs dispatch the partial / finalized text.

  it('ST-1r discriminator: a no-final session after a prior session restores the draft and never dispatches', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    // One completed session so `origin` persists `'launcher'` — the live repro's
    // precondition (the live-text effect does not re-run for a 2nd+ launcher
    // session, so the mirror is never cleared at its start).
    emitListening(true, 'launcher');
    emitFinal('first');
    emitListening(false, 'launcher');
    companionDispatchMock.askActiveCompanion.mockClear();

    // This next session recognizes NOTHING — the draft must survive, unsent.
    type('draft I typed');
    emitListening(true, 'launcher');
    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('draft I typed');
  });

  it('ST-1r minimize: a silent session after Minimize never dispatches the pre-Minimize text (E-2 mirror sync)', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    const onOpenFeature = renderShell();

    type('STALE MIRROR PROBE 4477');
    act(() => {
      fireEvent.click(screen.getByLabelText('Minimize launcher'));
    });
    expect(input().value).toBe('');

    emitListening(true, 'launcher');
    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });

  it('ST-1r E-1 partial-cancel: a session ending with only a partial never dispatches and restores the bar', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    type('pre-session text');
    emitListening(true, 'launcher');
    emitPartial('e');
    expect(input().value).toBe('e');

    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('pre-session text');
  });

  it('ST-1r E-1 typed-error: an error end is a cancel (no dispatch, pre-session restore)', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    type('pre-session text');
    emitListening(true, 'launcher');
    emitFinal('hello');

    act(() => {
      emit('stt:state', {
        listening: false,
        code: 'noDevice',
        detail: 'x',
        origin: 'launcher',
      });
    });

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('pre-session text');
  });

  // ── Consecutive sessions (exactly-once per utterance) ──────────────────────

  // ── UX-2 — manual edit during a live segment ───────────────────────────────

  it('UX-2: a manual edit suppresses further partials for the session; a final still appends and the guard resets next session', () => {
    seatCompanion();
    renderShell();

    emitListening(true, 'launcher');
    emitPartial('hello');
    type('hello there');
    expect(input().value).toBe('hello there');

    // A further partial is suppressed (the edit is authoritative)...
    emitPartial('hello world', 2);
    expect(input().value).toBe('hello there');

    // ...but a finalized segment still appends.
    emitFinal('hello world', 3);
    expect(input().value).toBe('hello there hello world');

    emitListening(false, 'launcher');
    // A new session resets the guard: live partials write again.
    emitListening(true, 'launcher');
    emitPartial('fresh', 4);
    expect(input().value).toBe('fresh');
  });

  it('each session commits only its own utterance (never the accumulated transcript)', () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    emitListening(true, 'launcher');
    emitFinal('first');
    emitListening(false, 'launcher');
    emitListening(true, 'launcher');
    emitFinal('second', 2);
    emitListening(false, 'launcher');

    const calls = companionDispatchMock.askActiveCompanion.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('first');
    expect(calls[1][0]).toBe('second');
  });
});
