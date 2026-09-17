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
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { FredoFeatureClass } from '@/shared/classes/FredoFeatureClass';
import { HEARING_NOTHING_COPY, HEARING_NOTHING_MS } from '../LauncherCommandBar';
import {
  LauncherShell,
  replyBoundsEqual,
  selectCtrlSpaceAction,
  voiceStartErrorCopy,
  type CtrlSpaceContext,
} from '../LauncherShell';
import { HOLD_PENDING_CUE_MS, HOLD_THRESHOLD_MS } from '../launcherSpaceHold';

/**
 * Spec #2883 ST-2 (G-125 re-point) — the bar field's TAG is no longer assumed.
 * #2883 swaps the single-line `Input` for a `Textarea` while keeping
 * `role="searchbox"`, so every harness cast below resolves the field by ROLE and
 * types it as `BarField` (`.value` and `.setSelectionRange` exist on BOTH tags).
 * Re-pointed sites: the focus/caret legs (`:268`, `:299`), the live-transcript leg
 * (`:357`), and the three `input()` accessors (`:642`, `:1269`, `:1466`).
 */
type BarField = HTMLInputElement | HTMLTextAreaElement;

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
// Spec #2883 ST-2 — the stub also RECORDS the props it is handed, so the
// launcher → entity reply-band hand-off is observable without the real bubble.
const companionDispatchMock = vi.hoisted(() => ({
  askActiveCompanion: vi.fn((_text: string) => true),
}));
const companionEntityMock = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: (props: Record<string, unknown>) => {
    companionEntityMock.props.push(props);
    return null;
  },
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
  companionEntityMock.props.length = 0;
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

// ── 1. Pure cascade — ONE meaning: open, or pass ──────────────────────────────

describe('selectCtrlSpaceAction — Ctrl+Space has ONE meaning (pure, #2882 ST-4)', () => {
  const ctx = (over: Partial<CtrlSpaceContext>): CtrlSpaceContext => ({
    activeIsTextControl: false,
    activeInLauncher: false,
    ...over,
  });

  it('passes the chord through while typing in a text control OUTSIDE the launcher (the #2823 AC3 carve-out, RETAINED)', () => {
    expect(
      selectCtrlSpaceAction(ctx({ activeIsTextControl: true, activeInLauncher: false })),
    ).toBe('pass');
  });

  it('OPENS when the text control IS the launcher bar (the carve-out does not apply)', () => {
    expect(
      selectCtrlSpaceAction(ctx({ activeIsTextControl: true, activeInLauncher: true })),
    ).toBe('open');
  });

  it('OPENS by default — the chord ONLY shows/focuses the bar', () => {
    expect(selectCtrlSpaceAction(ctx({}))).toBe('open');
  });

  it('the retired listening branches are UNREACHABLE: the action set is exactly open | pass', () => {
    // G-125 — the shipped #2877 cascade (`companion-listen` / `launcher-listen` /
    // `launcher-cancel`) is retired together with the context fields that selected
    // it. `CtrlSpaceAction` is now the two-member union `'open' | 'pass'`; the
    // runtime pin below asserts NO input — including the presence/enablement
    // combinations the old cascade keyed on — can yield anything else.
    const everyContext: CtrlSpaceContext[] = [
      { activeIsTextControl: true, activeInLauncher: true },
      { activeIsTextControl: false, activeInLauncher: true },
      { activeIsTextControl: false, activeInLauncher: false },
    ];
    for (const c of everyContext) {
      expect(['open', 'pass']).toContain(selectCtrlSpaceAction(c));
    }
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

  it('G-125 re-point: Ctrl+Space with the bar focused SHOWS/FOCUSES the bar and NEVER starts a session (R-1.2)', () => {
    // Supersedes "case 2: … starts a LAUNCHER session": the bar-focused branch no
    // longer listens (nor cancels) — the chord has one meaning (R-1).
    renderShell();
    focusBar();

    ctrlSpace();

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
  });

  it('G-125 re-point: the retired away-dictate path starts NOTHING (R-1.4)', () => {
    // Supersedes "case 1: … starts a COMPANION session": the companion-away
    // pre-emption is retired — no keyboard gesture starts a companion-origin
    // capture any more.
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

  it('default Ctrl+Space opens the bar and does NOT start listening', () => {
    renderShell();

    ctrlSpace();

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
  });

  it('Ctrl+Space NEVER cancels and NEVER closes a live session (R-1.2/R-1.3)', () => {
    renderShell();
    emitListening(true, 'launcher');
    const input = focusBar() as BarField;

    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });

    // Neither a stop nor a cancel — the capture continues while Space is held.
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_cancel', undefined);
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_stop', undefined);
    // …and the bar stays mounted (the overlay is never closed by the chord).
    expect(input).toBeInTheDocument();
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

  it('caret (R-1.1/R-1.3): a summon from OUTSIDE the bar focuses it with the caret at the END; a repeat chord leaves the caret untouched', async () => {
    // The focus/caret placement runs in `requestAnimationFrame`, which vitest does
    // NOT fake by default — so wait a real frame instead of advancing fake timers.
    const nextFrame = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    renderShell();
    const input = screen.getByRole('searchbox') as BarField;

    // The bar holds an uncommitted transcript.
    act(() => {
      fireEvent.change(input, { target: { value: 'hello' } });
    });
    // Park the caret at the START so "moved to the end" is a real observation.
    input.setSelectionRange(0, 0);
    // Focus is somewhere OUTSIDE the launcher (so the input is not already focused).
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });
    await nextFrame();

    expect(document.activeElement).toBe(input);
    // The caret is at the END — typing appends and never overwrites a character.
    expect(input.selectionStart).toBe(input.value.length);

    // A repeat chord must NOT disturb an existing caret (R-1.3).
    input.setSelectionRange(2, 2);
    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });
    await nextFrame();
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    outside.remove();
  });

  it('the retired away-dictate chord is INERT in every companion presence state (no residue, R-1.4/REQ-19)', async () => {
    // G-125 re-point of the #2877 F-38 repro: that test pinned the companion-away
    // cascade re-invoking `stt_start`. There is no such branch any more — the only
    // observable is ZERO sessions, whatever the companion is doing.
    for (const state of [
      { isVisible: true, isAway: true, isAutoHidden: false, isInUse: false },
      { isVisible: true, isAway: false, isAutoHidden: false, isInUse: false },
      { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
      { isVisible: true, isAway: false, isAutoHidden: false, isInUse: true },
    ]) {
      cleanup();
      companionMock.current.state = state;
      renderShell();
      await act(async () => {
        fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
        await Promise.resolve();
      });
      expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
    }
  });

  it('the bar input tracks the live transcript (partial → partial → final) and never submits', () => {
    const onOpenFeature = renderShell();

    emitListening(true, 'launcher');
    const input = screen.getByRole('searchbox') as BarField;

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

  // ── R-1.2 — no context (voice enablement, companion presence) selects a
  // listening branch any more; the chord's only variance is the AC-3 carve-out ──

  it('with voice disabled Ctrl+Space still OPENS the bar and NEVER starts listening', () => {
    companionMock.current.voiceEnabled = false;
    renderShell();
    focusBar();

    ctrlSpace();

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
  });

  it('with voice disabled a companion-away chord never starts a companion session', () => {
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

  it('DR-11 (G-125 re-point): a start failure surfaces the curated inline role=alert, never the raw IPC detail', () => {
    // Supersedes the #2877 leg that drove this through a bar-focused Ctrl+Space
    // `stt_start` failure: no keyboard gesture starts a capture any more (ST-4
    // retired the listening cascade; ST-5 owns the hold). The app-global
    // `stt:state` is the shipped failure channel, and the assertion (curated copy
    // wins over the raw backend detail) is unchanged.
    renderShell();

    act(() => {
      emit('stt:state', {
        listening: false,
        code: 'modelMissing',
        detail: 'raw ipc string',
        origin: 'launcher',
      });
    });

    const status = screen.getByTestId('launcher-command-listening-status');
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

  it('R-5.3: a companion-origin session shows NO bar cue', () => {
    // The `origin === 'launcher'` gate on the bar cue is unchanged; the
    // companion-origin surface it used to defer to was retired in #2882 ST-6.
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

describe('LauncherShell — the ONE commit path (Enter) + autosend finalize', () => {
  const MISSION_MONITOR = {
    id: 'mission-monitor',
    name: 'Mission Monitor',
    icon: () => null,
  } as unknown as FredoFeatureClass;
  const SETTINGS = {
    id: 'settings',
    name: 'Settings',
    icon: () => null,
  } as unknown as FredoFeatureClass;
  const MONITOR_TWO = {
    id: 'monitor-two',
    name: 'Monitor Two',
    icon: () => null,
  } as unknown as FredoFeatureClass;

  const renderShell = (features: FredoFeatureClass[] = [MISSION_MONITOR]) => {
    const onOpenFeature = vi.fn();
    renderWithChakra(<LauncherShell showableFeatures={features} onOpenFeature={onOpenFeature} />);
    return onOpenFeature;
  };

  const input = () => screen.getByRole('searchbox') as BarField;

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

  // ── Enter contract (#2882 ST-4 — the whole-query matcher, R-5/R-6) ──────────

  it('G-125 re-point: a typed query that NAMES an app opens it and NEVER sends (the rule is no longer exact-full-name equality)', () => {
    // Supersedes "an exact full-name match launches": the binding rule is the
    // whole-query prefix / whole-word-run matcher (R-5.1/R-5.4), so `set`, `Miss`,
    // `monitor` and a longer prefix all launch — and a launch still wins over chat.
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    type('set');
    pressEnter();

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('settings');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('R-5.4: `Miss` / `monitor` / `Mission Mon` / a padded full name all open Mission Monitor', () => {
    for (const query of ['Miss', 'miss', 'monitor', 'Mission Mon', 'mission monitor', '  mission monitor  ']) {
      cleanup();
      companionDispatchMock.askActiveCompanion.mockClear();
      const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

      type(query);
      pressEnter();

      expect(onOpenFeature, query).toHaveBeenCalledTimes(1);
      expect(onOpenFeature.mock.calls[0][0], query).toBe('mission-monitor');
      expect(companionDispatchMock.askActiveCompanion, query).not.toHaveBeenCalled();
    }
  });

  it('R-5.2: the open happens INDEPENDENT of the companion state — including while replying', () => {
    for (const state of [
      { isVisible: true, isAway: true, isAutoHidden: false, isInUse: false }, // away
      { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false }, // off
      { isVisible: true, isAway: false, isAutoHidden: false, isInUse: true }, // replying (busy)
      { isVisible: true, isAway: false, isAutoHidden: false, isInUse: false }, // at home
    ]) {
      cleanup();
      companionDispatchMock.askActiveCompanion.mockClear();
      companionMock.current.state = state;
      const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

      type('mission');
      pressEnter();

      expect(onOpenFeature, JSON.stringify(state)).toHaveBeenCalledTimes(1);
      expect(onOpenFeature.mock.calls[0][0], JSON.stringify(state)).toBe('mission-monitor');
      expect(companionDispatchMock.askActiveCompanion, JSON.stringify(state)).not.toHaveBeenCalled();
    }
  });

  it('R-5.3: when several apps match, the TOP-RANKED (first rendered) one opens', () => {
    companionDispatchMock.askActiveCompanion.mockClear();
    // BOTH entries match the whole-word run `monitor`; the first rendered entry is
    // the top-ranked match (clarification #1) — order is never re-sorted.
    const onOpenFeature = renderShell([MISSION_MONITOR, MONITOR_TWO]);

    type('monitor');
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

  it('G-125 re-point (R-6.1): a non-match with NO companion leaves the bar untouched and opens NOTHING (the `openSelected` fall-through is retired)', () => {
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    type('hello there');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    // The retired bug: the substring-filtered tile used to open here.
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(input().value).toBe('hello there');
  });

  it('R-6.2: `Missing all the time` (which CONTAINS `Miss`) never opens a tile', () => {
    const onOpenFeature = renderShell([MISSION_MONITOR]);

    type('Missing all the time');
    pressEnter();

    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('Missing all the time');
  });

  it('R-5.4/R-6.1: `MM` (an alias) and `ission` (a fragment) never open the filtered tile', () => {
    for (const query of ['MM', 'ission']) {
      cleanup();
      companionDispatchMock.askActiveCompanion.mockClear();
      const onOpenFeature = renderShell([MISSION_MONITOR]);

      type(query);
      pressEnter();

      expect(onOpenFeature, query).not.toHaveBeenCalled();
      expect(input().value, query).toBe(query);
    }
  });

  it('G-125 re-point: busy is NOT a global no-op — a TYPED match still launches while Fredo is replying (AC5)', () => {
    // Supersedes "busy is a GLOBAL no-op": the busy gate now affects only the
    // SEND path. This is the exact supersession AC5 names ("…present, away, off,
    // or replying").
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: true,
    };
    const onOpenFeature = renderShell([MISSION_MONITOR]);

    type('Miss');
    pressEnter();

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('mission-monitor');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('busy: a typed NON-match is a no-op (no send, no launch)', () => {
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
    expect(input().value).toBe('hello there');
  });

  // ── Clarification #2 — dictation provenance survives editing (R-4.3) ────────

  it('R-4.3/clarification #2: a DICTATED transcript is Fredo-bound on Enter even after being edited into an app name', () => {
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    // A launcher-origin capture finalizes `set` (autosend OFF — the shipped default).
    emitListening(true, 'launcher');
    emitFinal('set');
    emitListening(false, 'launcher');
    expect(input().value).toBe('set');

    // The user EDITS it into an exact app name. Provenance survives the edit.
    type('Settings');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('Settings');
    expect(onOpenFeature).not.toHaveBeenCalled();
  });

  it('CONTROL for R-4.3: the same text typed from scratch DOES open the app', () => {
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    type('Settings');
    pressEnter();

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('settings');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('clarification #2 reset: emptying the bar returns it to typed provenance', () => {
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    emitFinal('set');
    emitListening(false, 'launcher');
    expect(input().value).toBe('set');

    // Clear the bar completely — the content stopped existing.
    type('');
    type('Settings');
    pressEnter();

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('settings');
  });

  it('R-4.4: a dictated transcript with NO active companion is left undelivered and opens no app', () => {
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    emitFinal('Settings');
    emitListening(false, 'launcher');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(input().value).toBe('Settings');
  });

  // ── Autosend finalize (R-2.5) ──────────────────────────────────────────────

  it('G-125 re-point (R-4.3): finalizing a transcript that SPELLS an exact tile name is SENT to Fredo — never launched', () => {
    // Supersedes the #2878 "autosend ON: finalizing an exact tile name launches"
    // expectation: a dictated phrase NEVER opens an app, whatever it spells.
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    const onOpenFeature = renderShell([MISSION_MONITOR]);

    emitListening(true, 'launcher');
    emitFinal('Mission Monitor');
    emitListening(false, 'launcher');

    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledTimes(1);
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('Mission Monitor');
  });

  it('R-4.4: autosend ON with NO active companion keeps the transcript and opens NOTHING', () => {
    companionMock.current.voiceAutosend = true;
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    emitFinal('Settings');
    emitListening(false, 'launcher');

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(input().value).toBe('Settings');
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

  it('G-125 re-point: the bar’s `×` cancel control suppresses autosend and restores the bar (the retired Ctrl+Space cancel branch is gone)', () => {
    // Supersedes "the Ctrl+Space launcher-cancel cascade …": the chord never
    // cancels any more (R-1.2). The same discard gesture is still reachable from
    // the visible `×` affordance — pinned here so the wiring is not lost.
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    renderShell();

    type('draft I typed');
    emitListening(true, 'launcher');
    emitPartial('hello');

    act(() => {
      fireEvent.click(screen.getByTestId('launcher-command-listening-cancel'));
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

// ── Spec #2882 ST-5-fix — the live-capture Enter guard (QA-10) + §7 selection ─
// QA-10 (bound): WHILE a launcher-origin capture is live (`voice.listening &&
// origin === 'launcher'`) Enter acts as NOTHING and the chip reads exactly
// `release Space to finish`. The guard is owned by the ST-5 WIRING and the hint +
// handler derive from ONE `resolveEnterAction` verdict (R-6.3), so the shipped
// chip can never contradict what Enter does. UI/UX §7: the accent-highlighted tile
// follows the top-ranked match so the tile agrees with the chip and with Enter.

describe('LauncherShell — the live-capture Enter guard (QA-10) + the §7 selection-follow', () => {
  const SETTINGS = {
    id: 'settings',
    name: 'Settings',
    icon: () => null,
  } as unknown as FredoFeatureClass;
  const MISSION_MONITOR = {
    id: 'mission-monitor',
    name: 'Mission Monitor',
    icon: () => null,
  } as unknown as FredoFeatureClass;
  const QUERY_VIEWER = {
    id: 'query-viewer',
    name: 'Query Viewer',
    icon: () => null,
  } as unknown as FredoFeatureClass;
  const RUN_CLI = {
    id: 'run-cli',
    name: 'Run CLI',
    icon: () => null,
  } as unknown as FredoFeatureClass;
  const STEPPER_PROBE = {
    id: 'stepper-probe',
    name: 'Stepper Probe',
    icon: () => null,
  } as unknown as FredoFeatureClass;

  const renderShell = (features: FredoFeatureClass[] = [QUERY_VIEWER, RUN_CLI, STEPPER_PROBE]) => {
    const onOpenFeature = vi.fn();
    renderWithChakra(<LauncherShell showableFeatures={features} onOpenFeature={onOpenFeature} />);
    return onOpenFeature;
  };

  const input = () => screen.getByRole('searchbox') as BarField;

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

  const pressArrow = (key: 'ArrowLeft' | 'ArrowRight') => {
    act(() => {
      fireEvent.keyDown(input(), { key });
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

  const seatCompanion = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: false,
    };
  };

  const setCompanionBusy = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: true,
    };
  };

  const hint = () => screen.getByTestId('launcher-command-hint');

  /** The accent-highlighted grid tile is the one carrying the roving `tabIndex={0}`. */
  const highlightedTiles = () =>
    within(screen.getByRole('grid'))
      .getAllByRole('button')
      .filter((el) => el.getAttribute('tabindex') === '0')
      .map((el) => el.getAttribute('aria-label'));

  // ── QA-10 — Enter is a NO-OP while a launcher-origin capture is live ────────

  it('QA-10: live text that NAMES an app is neither launched nor sent, the bar is untouched, and the chip reads `release Space to finish`', () => {
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    // A partially transcribed live segment that spells an app name — exactly the
    // text that must NOT be launched while the capture is still running.
    emitFinal('Miss');
    expect(input().value).toBe('Miss');

    // Char-for-char: the chip must be EXACTLY the bound copy (no ellipsis, no extra).
    expect(hint()).toHaveTextContent(/^release Space to finish$/);

    pressEnter();

    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('Miss');
  });

  it('QA-10: the chip reads `release Space to finish` on an EMPTY bar too, and Enter suppresses even the empty-query grid launch', () => {
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    // Char-for-char: the chip must be EXACTLY the bound copy (no ellipsis, no extra).
    expect(hint()).toHaveTextContent(/^release Space to finish$/);

    // Without the guard this empty bar would launch the highlighted first tile.
    pressEnter();

    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('QA-10 PRECEDENCE: `busy` (UI/UX §3 row 1) outranks the live capture (row 2) — chip `Fredo is replying…`, Enter still a no-op', () => {
    setCompanionBusy();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    emitFinal('Miss');

    expect(hint()).toHaveTextContent(/^Fredo is replying…$/);

    pressEnter();

    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(input().value).toBe('Miss');
  });

  // ── UI/UX §7 — the highlighted tile follows the top-ranked match ────────────

  it('UI/UX §7: the accent-highlighted tile follows the top-ranked match and agrees with the chip AND with what Enter opens', () => {
    const onOpenFeature = renderShell();
    // Every name contains `r`, so the results list is all three tiles — but only
    // `Run CLI` rule-matches (`r` is a whole-query prefix there, not a fragment of
    // `Query Viewer` / `Stepper Probe`). The highlight must land on it.
    type('r');

    expect(screen.getByTestId('launcher-command-hint')).toHaveTextContent(/^↵ open Run CLI$/);
    expect(highlightedTiles()).toEqual(['Run CLI']);

    pressEnter();
    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('run-cli');
  });

  it('UI/UX §7: arrow-key navigation still wins within a query and is never snapped back', () => {
    renderShell();
    type('r');
    expect(highlightedTiles()).toEqual(['Run CLI']);

    pressArrow('ArrowRight');
    expect(highlightedTiles()).toEqual(['Stepper Probe']);

    pressArrow('ArrowLeft');
    expect(highlightedTiles()).toEqual(['Run CLI']);
  });

  it('the empty-grid and empty-query Enter behaviours do not move (the §7 effect is selection-only)', () => {
    // Empty GRID: Enter opens nothing (unchanged).
    const onOpenEmptyGrid = renderShell([]);
    pressEnter();
    expect(onOpenEmptyGrid).not.toHaveBeenCalled();
    cleanup();

    // Empty QUERY: Enter still opens the highlighted tile (the grid's own
    // keyboard affordance, R-5.1 — never a send).
    const onOpenFirst = renderShell();
    pressEnter();
    expect(onOpenFirst).toHaveBeenCalledTimes(1);
    expect(onOpenFirst.mock.calls[0][0]).toBe('query-viewer');
  });
});

// ── Spec #2882 ST-5 — the hold-to-dictate capture lifecycle ───────────────────
// R-2.1-2.7 (arm / hold / tap / release-before-live), R-2.5 (blur = stop with the
// autosend commit suppressed), R-2.4 (the cue spans the WHOLE gesture), R-3.2/3.3
// (no capture and no error without usable voice), R-4.1/R-4.2 (the finalized
// transcript flows through the existing ST-4 commit path unchanged).
//
// #2887 ST-5 re-points the cue COPY only (G-125): the armed/pending windows now
// show `Hold to dictate…` instead of `Listening…` (R-3 — only a live capture may
// claim listening). Every gesture assertion below (consume, arm, tap, finalize,
// one-space, routing) is unchanged.

describe('LauncherShell — hold-Space dictates (ST-5: the capture lifecycle)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const startCallCount = () =>
    invokeSpy.mock.calls.filter(([command]) => command === 'stt_start').length;

  /**
   * `live`    — the engine confirms immediately (the harness's normal shape), so
   *             the cue escalates to the live Listening state.
   * `pending` — the start never settles inside the test window, so the bounded
   *             pending cue and the release-before-live (R-2.6) path are drivable.
   */
  const renderArmedShell = async (start: 'live' | 'pending' = 'live') => {
    invokeSpy.mockImplementation((async (command: string) => {
      if (command === 'stt_check_model') return { ready: true };
      if (command === 'stt_start') {
        return start === 'live' ? okStart() : new Promise(() => {});
      }
      return undefined;
    }) as never);
    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);
    // ST-3's probe is fail-closed: nothing is armed until it affirms.
    await act(async () => {
      await Promise.resolve();
    });
  };

  const input = () => screen.getByRole('searchbox') as BarField;

  const focusBar = () => {
    const el = input();
    act(() => {
      el.focus();
      fireEvent.focus(el);
    });
    return el;
  };

  /** Returns true iff the keydown was CONSUMED (`preventDefault`). */
  const spaceDown = (repeat = false): boolean => {
    let consumed = false;
    act(() => {
      consumed = !fireEvent.keyDown(input(), { key: ' ', code: 'Space', repeat });
    });
    return consumed;
  };

  const spaceUp = () =>
    act(() => {
      fireEvent.keyUp(document, { key: ' ', code: 'Space' });
    });

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

  const seatCompanion = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: false,
    };
  };

  // ── R-2.1/R-2.2/R-2.4 — arming, the swallow, the cue ────────────────────────

  it('R-2.1/R-2.4: the qualifying keydown is consumed, the cue appears at once, and NO capture starts', async () => {
    await renderArmedShell();
    const el = focusBar();
    // S1 — the promise placeholder while holding Space would dictate.
    expect(el).toHaveAttribute('placeholder', 'search, or hold Space to dictate');

    expect(spaceDown()).toBe(true); // preventDefault: no space reaches the input
    expect(el.value).toBe('');
    // #2887 ST-5 (G-125 re-point — was `Listening…`): the armed window acknowledges
    // the gesture without claiming capture (R-3); `startCallCount()` below proves no
    // session exists yet.
    expect(el).toHaveAttribute('placeholder', 'Hold to dictate…');
    // …but nothing is live yet: no dot, no chip, no mic.
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    expect(startCallCount()).toBe(0);

    spaceUp();
  });

  it('R-2.2: while armed EVERY Space keydown (auto-repeat included) is swallowed — exactly one capture', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();

    // Auto-repeats (and a re-press) never restart the capture and never leak a space.
    expect(spaceDown(true)).toBe(true);
    expect(spaceDown(true)).toBe(true);
    expect(spaceDown()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
    });
    expect(startCallCount()).toBe(1);
    expect(input().value).toBe('');

    spaceUp();
  });

  // ── R-2.7 — a sub-threshold release is an ordinary space ────────────────────

  it('R-2.7: a sub-threshold TAP writes exactly ONE ordinary space and never opens the mic', async () => {
    await renderArmedShell();
    focusBar();
    spaceDown();

    act(() => {
      vi.advanceTimersByTime(80);
    });
    spaceUp();

    expect(input().value).toBe(' '); // exactly one character — never 0, never 2
    expect(startCallCount()).toBe(0);

    // The cleared timer can never fire late.
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(startCallCount()).toBe(0);
  });

  // ── R-2.1/R-2.5.4/R-2.3 — the hold, the bounded pending cue, the finalize ────

  it('R-2.1/S2: crossing the 200 ms threshold starts a launcher-origin capture; the pending chip is bounded', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();

    // Below the threshold no capture is attempted at all (the tap never opens the mic).
    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS - 1);
    });
    expect(startCallCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(invokeSpy).toHaveBeenCalledWith('stt_start', { origin: 'launcher' });

    // The `starting voice input…` chip is withheld until the pending window
    // outlives the bounded cue (HOLD_PENDING_CUE_MS).
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(HOLD_PENDING_CUE_MS);
    });
    expect(screen.getByTestId('launcher-command-listening-pending')).toHaveTextContent(
      'starting voice input…',
    );
    // #2887 ST-5 (G-125 re-point — was `Listening…`): the pending window is still a
    // non-listener — the chip says what is happening, the field acknowledges the hold.
    expect(input()).toHaveAttribute('placeholder', 'Hold to dictate…');

    // The engine confirms: S2 → S3, and the chip slot swaps to the Listening chip
    // (exactly ONE indicator, never both).
    emitListening(true, 'launcher');
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    expect(screen.getByTestId('launcher-command-listening-chip')).toHaveTextContent('Listening');
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();

    spaceUp();
  });

  it('R-2.3: releasing while live finalizes — the transcript is ordinary editable text and NO space lands', async () => {
    await renderArmedShell();
    const el = focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });
    emitListening(true, 'launcher');
    emitFinal('hello there');

    spaceUp();

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    expect(el.value).toBe('hello there');
    // The input stays ordinary editable text (AC2).
    expect(el).not.toHaveAttribute('readonly');
  });

  // ── R-2.6 — the stale-hold guard (the mic-hot race) ─────────────────────────

  it('R-2.6: a release before the engine confirms cancels the late session on its rise edge and writes ONE space', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();
    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
    });

    spaceUp();

    // The hold never captured, so it types exactly one ordinary space…
    expect(input().value).toBe(' ');
    // …and no cancel is issued yet (there is no active session to cancel).
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_cancel', undefined);

    // The late session reports live: it is cancelled immediately (the microphone is
    // never left capturing), and the landed space survives the discard.
    emitListening(true, 'launcher');
    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(input().value).toBe(' ');
  });

  // ── R-2.5 — blur is a STOP that KEEPS the words (QA-9 CLOSED) ───────────────

  it('R-2.5: a blur mid-capture stops the session, keeps the words and SUPPRESSES the autosend commit', async () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    await renderArmedShell();
    const el = focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });
    emitListening(true, 'launcher');
    emitFinal('set');

    act(() => {
      fireEvent.blur(el);
    });
    // The backend's answer to `stt_stop`: the session ends. ST-5-fix (G-125
    // re-point — the assertion itself is UNCHANGED): the chip is now also derived
    // from the live-capture state, so the stop transfer must be driven before the
    // post-stop chip is asserted. While the session is still reported live the
    // chip is `release Space to finish` — pinned by the QA-10 tests above.
    emitListening(false, 'launcher');

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    // The words are KEPT as a dictated transcript — and never dispatched.
    expect(el.value).toBe('set');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    // Provenance survives, so the hint truthfully names the send.
    expect(screen.getByTestId('launcher-command-hint')).toHaveTextContent(
      '↵ send transcript to Fredo',
    );

    // The trailing release adds nothing and re-stops nothing.
    spaceUp();
    expect(el.value).toBe('set');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('R-2.5: a WINDOW blur mid-capture is the same STOP (words kept, autosend suppressed)', async () => {
    seatCompanion();
    companionMock.current.voiceAutosend = true;
    await renderArmedShell();
    focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });
    emitListening(true, 'launcher');
    emitFinal('miss');

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    expect(input().value).toBe('miss');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  // ── §5.7 — Escape disarms the pending hold ─────────────────────────────────

  it('§5.7: Escape during a hold disarms it — no space on the trailing release and no stop', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();
    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
    });

    act(() => {
      fireEvent.keyDown(input(), { key: 'Escape' });
    });
    // The cancel path (never the finalize/stop control) and no space yet.
    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_stop', undefined);
    expect(input().value).toBe('');

    spaceUp();
    expect(input().value).toBe('');
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_stop', undefined);
  });

  // ── R-3.2/R-3.3 — no usable voice: nothing promised, nothing attempted ──────

  it('R-3.3: with the model not ready the keydown is NOT consumed, no capture is attempted and no error shows', async () => {
    // The default harness answers `stt_check_model` with undefined → fail-closed.
    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    const el = focusBar();
    // No promise is made: readiness unknown ⇒ the legacy resting copy (contract 4c).
    expect(el).toHaveAttribute('placeholder', 'search or command');

    expect(spaceDown()).toBe(false); // the native space is left alone (AC3)
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(startCallCount()).toBe(0);
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-status')).toBeNull();
  });

  it('R-3.2: with voice disabled an empty-bar Space is never consumed and never starts a capture', async () => {
    companionMock.current.voiceEnabled = false;
    await renderArmedShell();
    focusBar();

    expect(spaceDown()).toBe(false);
    spaceUp();
    expect(startCallCount()).toBe(0);
    expect(screen.queryByTestId('launcher-command-listening-status')).toBeNull();
  });

  // ── R-2.5.6/AC3 — a hold-origin start failure is SILENT ────────────────────

  it('AC3: a hold-origin start failure lands one space and surfaces NO alert', async () => {
    invokeSpy.mockImplementation((async (command: string) => {
      if (command === 'stt_check_model') return { ready: true };
      if (command === 'stt_start') {
        return { started: false, code: 'noDevice', detail: 'raw ipc string', deviceName: null, sampleRate: null };
      }
      return undefined;
    }) as never);
    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });

    spaceUp();

    expect(input().value).toBe(' ');
    expect(startCallCount()).toBe(1);
    expect(screen.queryByTestId('launcher-command-listening-status')).toBeNull();
    expect(screen.queryByText('raw ipc string')).toBeNull();
  });

  // ── R-4.3 / clarification #2 — provenance survives editing ─────────────────

  it('R-4.3/clarification #2: a finalized transcript is dictated — a later EDIT never re-types it', async () => {
    seatCompanion();
    await renderArmedShell();
    const el = focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });
    emitListening(true, 'launcher');
    emitFinal('set');
    spaceUp();
    // The backend's answer to the release (`stt_stop` → `listening:false`). ST-5-fix
    // (G-125 re-point — same assertion): the chip is now derived from the live-capture
    // state too, so the session end must be driven before asserting the post-capture
    // chip. The live-capture chip is pinned by the QA-10 tests above.
    emitListening(false, 'launcher');

    expect(el.value).toBe('set');
    expect(screen.getByTestId('launcher-command-hint')).toHaveTextContent(
      '↵ send transcript to Fredo',
    );

    // Editing the transcript to an app name does NOT make it typed (clarification #2).
    act(() => {
      fireEvent.change(el, { target: { value: 'Settings' } });
    });
    expect(screen.getByTestId('launcher-command-hint')).toHaveTextContent(
      '↵ send transcript to Fredo',
    );
  });
});

// ── Spec #2883 ST-2 — the #2882 keyboard contract across the field swap ───────
// R-1.4: `Shift+Enter` inserts a newline through the browser's NATIVE insertion —
// the handler returns BEFORE the Enter branch WITHOUT `preventDefault`, so the
// field edits itself and its `onChange` carries the newline through the ONE
// `handleQueryChange` route. It starts ZERO generations and opens ZERO windows.
// R-1.5: plain `Enter` still `preventDefault`s and commits the whole trimmed
// query through the UNCHANGED #2882 `resolveEnterAction`.
//
// G-161 oracle: `fireEvent.keyDown`'s RETURN VALUE is the `preventDefault`
// oracle (`false` ⇔ the handler called `preventDefault`), so interception is
// judged without relying on jsdom performing a native text insertion (it does
// not) and without a synthetic-chord `code` assumption.

describe('LauncherShell — #2883 ST-2: Shift+Enter adds a line, Enter is untouched', () => {
  const SETTINGS = {
    id: 'settings',
    name: 'Settings',
    icon: () => null,
  } as unknown as FredoFeatureClass;

  const renderShell = () => {
    const onOpenFeature = vi.fn();
    renderWithChakra(<LauncherShell showableFeatures={[SETTINGS]} onOpenFeature={onOpenFeature} />);
    return onOpenFeature;
  };

  const input = () => screen.getByRole('searchbox') as BarField;

  const type = (value: string) => {
    act(() => {
      fireEvent.change(input(), { target: { value } });
    });
  };

  /** `true` ⇔ the handler called `preventDefault` (G-161 oracle). */
  const keydownPrevented = (init: { key: string; code?: string; shiftKey?: boolean }): boolean => {
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(input(), init);
    });
    return prevented;
  };

  const seatCompanion = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: false,
    };
  };

  it('R-1.4: Shift+Enter is NOT intercepted (the browser inserts the newline), sends nothing and opens nothing', () => {
    seatCompanion();
    const onOpenFeature = renderShell();
    // `set` rule-matches Settings — an intercepted (or manual-splice) path would
    // have launched it.
    type('set');
    companionDispatchMock.askActiveCompanion.mockClear();

    expect(keydownPrevented({ key: 'Enter', code: 'Enter', shiftKey: true })).toBe(false);

    // ZERO generations, ZERO windows, and no manual splice of the text (the
    // handler never edits the value itself — the textarea's onChange does).
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(input().value).toBe('set');
  });

  it('R-1.5: plain Enter IS intercepted and still opens the matching app', () => {
    seatCompanion();
    const onOpenFeature = renderShell();
    type('set');

    expect(keydownPrevented({ key: 'Enter', code: 'Enter' })).toBe(true);

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('settings');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('R-1.4: a Shift+Enter never disturbs a later Enter (the #2882 verdict is unchanged)', () => {
    seatCompanion();
    const onOpenFeature = renderShell();
    type('set');

    // Not intercepted: on the real `Textarea` the browser inserts the newline.
    expect(keydownPrevented({ key: 'Enter', code: 'Enter', shiftKey: true })).toBe(false);
    // The field's change route then delivers the edited value (jsdom performs no
    // native insertion), and Shift+Enter must leave no residue behind.
    type('set more');

    expect(keydownPrevented({ key: 'Enter', code: 'Enter' })).toBe(true);
    // `set more` does not rule-match Settings ⇒ the UNCHANGED send verdict.
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('set more');
    expect(onOpenFeature).not.toHaveBeenCalled();
  });

  it('R-1.4/R-1.5 (REQ-14d): a multi-line query is committed WHOLE by Enter — never a launch, never spliced', () => {
    seatCompanion();
    const onOpenFeature = renderShell();
    // The textarea's OWN value route carries the newline (jsdom cannot perform the
    // native insertion a real `Shift+Enter` triggers, so it is delivered the way
    // the field's `onChange` would).
    type('set\nmore');

    expect(keydownPrevented({ key: 'Enter', code: 'Enter' })).toBe(true);
    expect(onOpenFeature).not.toHaveBeenCalled();
    // The whole trimmed text — including both lines — reaches the ONE send path.
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('set\nmore');
  });
});

// ── Spec #2883 ST-2 — the reply band's loop guard (AGENTS.md #523) ────────────
// The launcher re-measures the band from a rAF-coalesced ResizeObserver/scroll/
// resize trigger; the state write must happen ONLY when a number actually
// changed, or every frame/keystroke would drive a render (the #523 loop class).

describe('replyBoundsEqual — the band is written ONLY when a number changes', () => {
  const band = { safeTop: 66, barrierTop: 400, boundsLeft: 100, boundsRight: 860 };

  it('is true iff all four measured numbers are identical', () => {
    expect(replyBoundsEqual(band, { ...band })).toBe(true);
  });

  it('is false for a change in ANY one measured number', () => {
    for (const key of ['safeTop', 'barrierTop', 'boundsLeft', 'boundsRight'] as const) {
      expect(replyBoundsEqual(band, { ...band, [key]: band[key] + 1 })).toBe(false);
    }
  });
});

// ── Spec #2883 ST-2 — the measured band flows launcher → entity ───────────────
// R-2.2/R-2.3: the launcher measures the band (the notch offset as `safeTop`, the
// command bar's box top as `barrierTop`, the launcher column's clip box as
// `boundsLeft`/`boundsRight`) and hands it to the SEATED entity, which forwards it
// to the bubble (ST-6). Before the first measurement it is `undefined`, so today's
// fixed rendering is untouched (R-5.3).

describe('LauncherShell — #2883 ST-2: the measured reply band reaches the seat entity', () => {
  const seatCompanion = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: false,
    };
  };

  it('hands a ReplySurfaceBounds to the seated entity once the band is measured', async () => {
    seatCompanion();
    // jsdom implements neither `ResizeObserver` nor non-zero layout: stub the
    // observer so the rAF-coalesced measurement actually runs.
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);
    // The first measurement is rAF-coalesced — wait a real frame.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const seated = companionEntityMock.props.filter((props) => props.surface === 'seat');
    expect(seated.length).toBeGreaterThan(0);
    const handed = seated[seated.length - 1].replyBounds as Record<string, unknown>;
    // The band's bound `SAFE_TOP` = the chrome notch (58px) + the shared margin.
    expect(handed.safeTop).toBe(66);
    // The other three are MEASURED viewport numbers (jsdom has no layout, so only
    // presence/type is pinned here — the live round owns the real geometry).
    expect(handed.barrierTop).toEqual(expect.any(Number));
    expect(handed.boundsLeft).toEqual(expect.any(Number));
    expect(handed.boundsRight).toEqual(expect.any(Number));
  });
});
