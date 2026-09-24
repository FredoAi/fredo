/**
 * Spec #2877 ST-5 — launcher voice dictation: the Ctrl+Space/Escape wiring, the
 * launcher-origin capture cue, the hold-Space gesture lifecycle and the
 * model-audio delivery glue.
 *
 * Spec #2914 ST-5 — voice input has exactly ONE path (captured model audio
 * delivered loopback to the local multimodal server). The `false→transcript→bar`
 * path, `normalizeTranscriptSegment`, the dictation provenance/autosend finalize
 * and the sherpa `stt_check_model`/`stt_warm` readiness gate are REMOVED, so the
 * transcript-shaping, autosend and local-mode pins are gone (their named
 * replacements are the model-audio dispatch + limit pins and the R-3
 * arming-without-a-model pin below).
 *
 * Pins:
 *   1. `selectCtrlSpaceAction` — the binding cascade: the #2823 AC3 carve-out
 *      runs first; else `open` WITHOUT listening.
 *   2. `voiceStartErrorCopy` — curated, actionable copy per typed failure code.
 *   3. `deriveHoldCue` — the pure honest cue (`'listening'` ONLY while live).
 *   4. The document-listener wiring: Escape cancels a live session before the
 *      launcher close; the chord itself never starts/stops/cancels.
 *   5. The model-audio chip + placeholder + Stop/Cancel controls while live.
 *   6. DR-9: disabling voice mid-session stops the session.
 *   7. Enter: the ONE typed commit path (launch / send / no-op).
 *   8. QA-10: WHILE a launcher-origin capture is live Enter is a NO-OP.
 *   9. Hold-Space: arm / swallow / tap / threshold / finalize / blur / cancel.
 *  10. R-3: arming works with NO sherpa model present (voice-enabled only).
 *  11. The model-audio delivery glue: `stt_take_audio_clip` → audio dispatch,
 *      exactly once per session, with a text-only failure alert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { FredoFeatureClass } from '@/shared/classes/FredoFeatureClass';
import { HEARING_NOTHING_COPY, HEARING_NOTHING_MS } from '../LauncherCommandBar';
import {
  LauncherShell,
  deriveHoldCue,
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
    // #2892 ST-5 — the truthful reply-generation primitive (busy) and the accepted
    // queued-send count, both top-level on the context value.
    replyInFlight: false,
    queuedSendCount: 0,
  },
}));
vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => companionMock.current,
}));

// #2878 ST-1 — the ONE text dispatch path (`askActiveCompanion`) is spied so the
// commit contract (launch vs send vs no-op) is observable without mounting the
// real entity. Spec #2897 ST-6 — the audio dispatch (`askActiveCompanionWithAudio`)
// is spied for the delivery glue. `CompanionEntity` is stubbed.
const companionDispatchMock = vi.hoisted(() => ({
  askActiveCompanion: vi.fn((_text: string) => ({ outcome: 'dispatched' as const })),
  askActiveCompanionWithAudio: vi.fn((_clip: string) => ({ outcome: 'dispatched' as const })),
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
  askActiveCompanionWithAudio: companionDispatchMock.askActiveCompanionWithAudio,
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
    replyInFlight: false,
    queuedSendCount: 0,
  };
  companionDispatchMock.askActiveCompanion.mockReset();
  companionDispatchMock.askActiveCompanion.mockReturnValue({ outcome: 'dispatched' });
  companionDispatchMock.askActiveCompanionWithAudio.mockReset();
  companionDispatchMock.askActiveCompanionWithAudio.mockReturnValue({
    outcome: 'dispatched',
  });
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

  it('the action set is exactly open | pass over every context', () => {
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

// ── 3. The ONE honest cue derivation (R-3/AC3) ────────────────────────────────

describe('deriveHoldCue — the honest cue (#2887 ST-7, R-3/AC3; #2914 ST-9)', () => {
  const input = (over: Partial<Parameters<typeof deriveHoldCue>[0]>) => ({
    captureLive: false,
    armed: false,
    pending: false,
    ...over,
  });

  it('R-3: `listening` is reachable ONLY while the capture is live — over every input combination', () => {
    for (const captureLive of [true, false]) {
      for (const armed of [true, false]) {
        for (const pending of [true, false]) {
          const combo = { captureLive, armed, pending };
          const cue = deriveHoldCue(combo);
          if (captureLive) {
            expect(cue, JSON.stringify(combo)).toBe('listening');
          } else {
            expect(cue, JSON.stringify(combo)).not.toBe('listening');
          }
        }
      }
    }
  });

  it("the keydown edge acknowledges the user's own gesture — never a listening claim", () => {
    expect(deriveHoldCue(input({ armed: true }))).toBe('acknowledge');
  });

  // Spec #2914 ST-9 (G-125 re-point) — the old `engineResident:false ⇒ warming`
  // leg pinned a residency stamp carried by the deleted wire field, so the
  // launch-window pending case is re-pointed to the ONE surviving honest state,
  // `'starting'` (the residency tier is gone — SA-11).
  it('the bounded pending gate selects the chip state (`starting` in every case — no residency tier)', () => {
    expect(deriveHoldCue(input({ armed: true, pending: true }))).toBe('starting');
    expect(deriveHoldCue(input({ pending: true }))).toBe('starting');
  });

  it('idle resolves to `none` (no cue at all)', () => {
    expect(deriveHoldCue(input({}))).toBe('none');
  });

  it('a live capture outranks every readying state (the clamp)', () => {
    expect(deriveHoldCue(input({ captureLive: true, armed: true, pending: true }))).toBe(
      'listening',
    );
  });
});

// ── 4. Ctrl+Space / Escape / capture wiring ───────────────────────────────────

describe('LauncherShell — Ctrl+Space / Escape / capture wiring', () => {
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

  it('Ctrl+Space with the bar focused SHOWS/FOCUSES the bar and NEVER starts a session (R-1.2)', () => {
    renderShell();
    focusBar();

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

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_cancel', undefined);
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_stop', undefined);
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
    const nextFrame = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    renderShell();
    const input = screen.getByRole('searchbox') as BarField;

    act(() => {
      fireEvent.change(input, { target: { value: 'hello' } });
    });
    input.setSelectionRange(0, 0);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });
    await nextFrame();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);

    input.setSelectionRange(2, 2);
    act(() => {
      fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
    });
    await nextFrame();
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    outside.remove();
  });

  it('with voice disabled Ctrl+Space still OPENS the bar and NEVER starts listening', () => {
    companionMock.current.voiceEnabled = false;
    renderShell();
    focusBar();

    ctrlSpace();

    expect(invokeSpy).not.toHaveBeenCalledWith('stt_start', expect.anything());
  });

  it('DR-9: disabling voice mid-session stops the session and announces it', async () => {
    const shell = () => <LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />;
    const { rerender } = renderWithChakra(shell());
    emitListening(true, 'launcher');
    expect(screen.getByTestId('voice-listening-announcer')).toHaveTextContent(
      'Fredo is listening',
    );

    companionMock.current.voiceEnabled = false;
    await act(async () => {
      rerender(shell());
      await Promise.resolve();
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    expect(screen.getByTestId('voice-listening-announcer')).toHaveTextContent('Voice input is off');
  });

  it('DR-7: the frozen dot, the model chip and the Stop control render while listening', () => {
    renderShell();
    emitListening(true, 'launcher');

    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      'Fredo is listening',
    );
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

  it('DR-7: the placeholder switches to `release Space to finish` while listening', () => {
    renderShell();
    const input = screen.getByRole('searchbox');
    expect(input).toHaveAttribute('placeholder', 'search or command');

    emitListening(true, 'launcher');
    expect(input).toHaveAttribute('placeholder', 'release Space to finish');
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

  it('DR-11: a start failure surfaces the curated inline role=alert, never the raw IPC detail', () => {
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

  it('R-5.3: a launcher-origin session shows the bar cue', () => {
    renderShell();
    emitListening(true, 'launcher');

    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-command-model-listening-chip')).toBeInTheDocument();
  });

  it('R-5.3: a companion-origin session shows NO bar cue', () => {
    renderShell();
    emitListening(true, 'companion');

    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-model-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
  });

  it('DR-10: the listening announcer flips once per transition', () => {
    renderShell();
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('');

    emitListening(true, 'launcher');
    expect(announcer).toHaveTextContent('Fredo is listening');

    emitListening(false, 'launcher');
    expect(announcer).toHaveTextContent('Stopped listening');
  });

  it('the transcript announcer stays mounted but is never fed (one path, no transcript)', () => {
    renderShell();
    emitListening(true, 'launcher');

    const announcer = screen.getByTestId('voice-transcript-announcer');
    expect(announcer).toBeInTheDocument();
    expect(announcer.textContent).toBe('');
  });
});

// ── 5. ONE commit path (Enter) ────────────────────────────────────────────────

describe('LauncherShell — the ONE commit path (Enter)', () => {
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

  const seatCompanion = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: false,
    };
  };

  it('a typed query that NAMES an app opens it and NEVER sends (R-5.1/R-5.4)', () => {
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    type('set');
    pressEnter();

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('settings');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('R-5.4: `Miss` / `monitor` / `Mission Mon` / a padded full name all open Mission Monitor', () => {
    for (const query of [
      'Miss',
      'miss',
      'monitor',
      'Mission Mon',
      'mission monitor',
      '  mission monitor  ',
    ]) {
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
      { isVisible: true, isAway: true, isAutoHidden: false, isInUse: false },
      { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
      { isVisible: true, isAway: false, isAutoHidden: false, isInUse: true },
      { isVisible: true, isAway: false, isAutoHidden: false, isInUse: false },
    ]) {
      cleanup();
      companionDispatchMock.askActiveCompanion.mockClear();
      companionMock.current.state = state;
      companionMock.current.replyInFlight = state.isInUse;
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

  it('R-6.1: a non-match with NO companion leaves the bar untouched and opens NOTHING', () => {
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    type('hello there');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
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

  it('busy is NOT a global no-op — a TYPED match still launches while Fredo is replying (AC5)', () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: true,
    };
    companionMock.current.replyInFlight = true;
    const onOpenFeature = renderShell([MISSION_MONITOR]);

    type('Miss');
    pressEnter();

    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('mission-monitor');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('while a reply is in flight, a typed NON-match with an active companion SENDS (bar clears)', () => {
    seatCompanion();
    companionMock.current.replyInFlight = true;
    const onOpenFeature = renderShell();

    type('hello there');
    pressEnter();

    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('hello there');
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });
});

// ── 6. The live-capture Enter guard (QA-10) + §7 selection-follow ────────────

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
  const TERMINAL = {
    id: 'terminal',
    name: 'Terminal',
    icon: () => null,
  } as unknown as FredoFeatureClass;
  const STEPPER_PROBE = {
    id: 'stepper-probe',
    name: 'Stepper Probe',
    icon: () => null,
  } as unknown as FredoFeatureClass;

  const renderShell = (features: FredoFeatureClass[] = [QUERY_VIEWER, TERMINAL, STEPPER_PROBE]) => {
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
    companionMock.current.replyInFlight = true;
  };

  /** The accent-highlighted grid tile is the one carrying the roving `tabIndex={0}`. */
  const highlightedTiles = () =>
    within(screen.getByRole('grid'))
      .getAllByRole('button')
      .filter((el) => el.getAttribute('tabindex') === '0')
      .map((el) => el.getAttribute('aria-label'));

  it('QA-10: while live, Enter is a NO-OP and the chip/placeholder reads `release Space to finish`', () => {
    seatCompanion();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    // The model chip is the ONLY listening claim; the instruction relocates into
    // the field placeholder (the hint chip is suppressed while the chip renders).
    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      'Fredo is listening',
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      'release Space to finish',
    );

    pressEnter();

    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('QA-10 PRECEDENCE: `busy` (UI/UX §3 row 1) outranks the live capture (row 2) — Enter still a no-op', () => {
    setCompanionBusy();
    const onOpenFeature = renderShell([MISSION_MONITOR, SETTINGS]);

    emitListening(true, 'launcher');
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Fredo is replying…');

    pressEnter();

    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('UI/UX §7: the accent-highlighted tile follows the top-ranked match and agrees with what Enter opens', () => {
    const onOpenFeature = renderShell();
    type('t');

    expect(screen.getByTestId('launcher-command-hint')).toHaveTextContent(/^↵ open Terminal$/);
    expect(highlightedTiles()).toEqual(['Terminal']);

    pressEnter();
    expect(onOpenFeature).toHaveBeenCalledTimes(1);
    expect(onOpenFeature.mock.calls[0][0]).toBe('terminal');
  });

  it('UI/UX §7: arrow-key navigation still wins within a query and is never snapped back', () => {
    renderShell();
    type('t');
    expect(highlightedTiles()).toEqual(['Terminal']);

    pressArrow('ArrowRight');
    expect(highlightedTiles()).toEqual(['Stepper Probe']);

    pressArrow('ArrowLeft');
    expect(highlightedTiles()).toEqual(['Terminal']);
  });

  it('the empty-grid and empty-query Enter behaviours do not move (the §7 effect is selection-only)', () => {
    const onOpenEmptyGrid = renderShell([]);
    pressEnter();
    expect(onOpenEmptyGrid).not.toHaveBeenCalled();
    cleanup();

    const onOpenFirst = renderShell();
    pressEnter();
    expect(onOpenFirst).toHaveBeenCalledTimes(1);
    expect(onOpenFirst.mock.calls[0][0]).toBe('query-viewer');
  });
});

// ── 7. Hold-Space capture lifecycle ──────────────────────────────────────────

describe('LauncherShell — hold-Space dictates (ST-5: the capture lifecycle)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const startCallCount = () =>
    invokeSpy.mock.calls.filter(([command]) => command === 'stt_start').length;

  const renderArmedShell = async (start: 'live' | 'pending' = 'live') => {
    invokeSpy.mockImplementation((async (command: string) => {
      if (command === 'stt_start') {
        return start === 'live' ? okStart() : new Promise(() => {});
      }
      return undefined;
    }) as never);
    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);
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

  it('R-2.1/R-2.4: the qualifying keydown is consumed, the cue appears at once, and NO capture starts', async () => {
    await renderArmedShell();
    const el = focusBar();
    expect(el).toHaveAttribute('placeholder', 'search, or hold Space to dictate');

    expect(spaceDown()).toBe(true);
    expect(el.value).toBe('');
    expect(el).toHaveAttribute('placeholder', 'Hold to dictate…');
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    expect(startCallCount()).toBe(0);

    spaceUp();
  });

  it('R-2.2: while armed EVERY Space keydown (auto-repeat included) is swallowed — exactly one capture', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();

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

  it('R-2.7: a sub-threshold TAP writes exactly ONE ordinary space and never opens the mic', async () => {
    await renderArmedShell();
    focusBar();
    spaceDown();

    act(() => {
      vi.advanceTimersByTime(80);
    });
    spaceUp();

    expect(input().value).toBe(' ');
    expect(startCallCount()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(startCallCount()).toBe(0);
  });

  it('R-2.1/S2: crossing the 200 ms threshold starts a launcher-origin capture; the pending chip is bounded', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();

    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS - 1);
    });
    expect(startCallCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(invokeSpy).toHaveBeenCalledWith('stt_start', { origin: 'launcher' });

    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(HOLD_PENDING_CUE_MS);
    });
    expect(screen.getByTestId('launcher-command-listening-pending')).toHaveTextContent(
      'starting voice input…',
    );
    expect(input()).toHaveAttribute('placeholder', 'Hold to dictate…');

    // The engine confirms: S2 → S3, and the slot swaps to the model chip.
    emitListening(true, 'launcher');
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      'Fredo is listening',
    );
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();

    spaceUp();
  });

  it('R-2.3: releasing while live finalizes — Stop is issued and NO space lands', async () => {
    await renderArmedShell();
    const el = focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });
    emitListening(true, 'launcher');

    spaceUp();

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    expect(el.value).toBe('');
    expect(el).not.toHaveAttribute('readonly');
  });

  it('R-3 (announcer): the armed/pending windows are NEVER announced as listening — the live region flips exactly once at capture and once on the stop', async () => {
    await renderArmedShell('pending');
    const el = focusBar();
    const announcer = screen.getByTestId('voice-listening-announcer');
    const seen: string[] = [];
    const record = () => seen.push(announcer.textContent ?? '');

    record();
    spaceDown();
    expect(el).toHaveAttribute('placeholder', 'Hold to dictate…');
    record();

    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS + HOLD_PENDING_CUE_MS);
    });
    expect(screen.getByTestId('launcher-command-listening-pending')).toHaveTextContent(
      'starting voice input…',
    );
    record();

    emitListening(true, 'launcher');
    record();

    spaceUp();
    await act(async () => {
      await Promise.resolve();
    });
    record();

    expect(seen).toEqual([
      '',
      '',
      'Starting voice input',
      'Fredo is listening',
      'Stopped listening',
    ]);
    // The capture is gone and the bar is empty + focused with voice enabled, so
    // the S1 promise returns (the gesture is available again — R-3).
    expect(el).toHaveAttribute('placeholder', 'search, or hold Space to dictate');
  });

  it('S4: Escape while LIVE announces `Dictation cancelled`, never `Stopped listening`', async () => {
    await renderArmedShell();
    focusBar();
    emitListening(true, 'launcher');
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('Fredo is listening');

    act(() => {
      fireEvent.keyDown(input(), { key: 'Escape' });
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(announcer).toHaveTextContent('Dictation cancelled');
    expect(announcer).not.toHaveTextContent('Stopped listening');
  });

  it('S4: the visible `×` while LIVE announces `Dictation cancelled`, never `Stopped listening`', async () => {
    await renderArmedShell();
    emitListening(true, 'launcher');
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('Fredo is listening');

    act(() => {
      fireEvent.click(screen.getByTestId('launcher-command-listening-cancel'));
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(announcer).toHaveTextContent('Dictation cancelled');
    expect(announcer).not.toHaveTextContent('Stopped listening');
  });

  it('S4: an Escape that disarms a PRE-CAPTURE hold (nothing was live) stays silent — no cancel announcement', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();
    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
    });
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('');

    act(() => {
      fireEvent.keyDown(input(), { key: 'Escape' });
    });

    expect(announcer).toHaveTextContent('');
  });

  it('R-2.6: a release before the engine confirms cancels the late session on its rise edge and writes ONE space', async () => {
    await renderArmedShell('pending');
    focusBar();
    spaceDown();
    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
    });

    spaceUp();

    expect(input().value).toBe(' ');
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_cancel', undefined);

    emitListening(true, 'launcher');
    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(input().value).toBe(' ');
  });

  it('R-2.5: a blur mid-capture stops the session and releases the mic', async () => {
    await renderArmedShell();
    const el = focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });
    emitListening(true, 'launcher');

    act(() => {
      fireEvent.blur(el);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
    expect(el.value).toBe('');
  });

  it('R-2.5: a WINDOW blur mid-capture is the same STOP', async () => {
    await renderArmedShell();
    focusBar();
    spaceDown();
    await act(async () => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
      await Promise.resolve();
    });
    emitListening(true, 'launcher');

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
  });

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
    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_stop', undefined);
    expect(input().value).toBe('');

    spaceUp();
    expect(input().value).toBe('');
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_stop', undefined);
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

  it('REQ-7: a hold-origin start failure lands one space and surfaces the curated copy (never the raw IPC detail)', async () => {
    invokeSpy.mockImplementation((async (command: string) => {
      if (command === 'stt_start') {
        return {
          started: false,
          code: 'noDevice',
          detail: 'raw ipc string',
          deviceName: null,
          sampleRate: null,
        };
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
    expect(screen.getByTestId('launcher-command-listening-status')).toHaveTextContent(
      'No microphone found',
    );
    expect(screen.queryByText('raw ipc string')).toBeNull();
  });
});

// ── 8. R-3 — arming with NO sherpa model ─────────────────────────────────────

describe('LauncherShell — R-3: arming with NO sherpa model', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const startCallCount = () =>
    invokeSpy.mock.calls.filter(([command]) => command === 'stt_start').length;

  it('voice enabled + empty focused bar arms and starts with NO model probe at all', async () => {
    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    const el = screen.getByRole('searchbox') as BarField;
    act(() => {
      el.focus();
      fireEvent.focus(el);
    });

    // The promise placeholder is offered on voice-enablement alone — there is no
    // fail-closed sherpa readiness probe withholding the gesture (R-3).
    expect(el).toHaveAttribute('placeholder', 'search, or hold Space to dictate');

    let consumed = false;
    act(() => {
      consumed = !fireEvent.keyDown(el, { key: ' ', code: 'Space' });
    });
    expect(consumed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(HOLD_THRESHOLD_MS);
    });
    expect(invokeSpy).toHaveBeenCalledWith('stt_start', { origin: 'launcher' });
    expect(startCallCount()).toBe(1);

    // The deleted sherpa readiness/warm commands are NEVER invoked.
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_check_model');
    expect(invokeSpy).not.toHaveBeenCalledWith('stt_warm', expect.anything());

    act(() => {
      fireEvent.keyUp(document, { key: ' ', code: 'Space' });
    });
  });
});

// ── 9. Shift+Enter adds a line, Enter is untouched ───────────────────────────

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

  it('R-1.4: Shift+Enter is NOT intercepted, sends nothing and opens nothing', () => {
    seatCompanion();
    const onOpenFeature = renderShell();
    type('set');
    companionDispatchMock.askActiveCompanion.mockClear();

    expect(keydownPrevented({ key: 'Enter', code: 'Enter', shiftKey: true })).toBe(false);

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
    renderShell();
    type('set');

    expect(keydownPrevented({ key: 'Enter', code: 'Enter', shiftKey: true })).toBe(false);
    type('set more');

    expect(keydownPrevented({ key: 'Enter', code: 'Enter' })).toBe(true);
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('set more');
  });

  it('R-1.4/R-1.5 (REQ-14d): a multi-line query is committed WHOLE by Enter — never a launch, never spliced', () => {
    seatCompanion();
    const onOpenFeature = renderShell();
    type('set\nmore');

    expect(keydownPrevented({ key: 'Enter', code: 'Enter' })).toBe(true);
    expect(onOpenFeature).not.toHaveBeenCalled();
    expect(companionDispatchMock.askActiveCompanion).toHaveBeenCalledWith('set\nmore');
  });
});

// ── 10. The reply band (loop guard + hand-off) ───────────────────────────────

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
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const seated = companionEntityMock.props.filter((props) => props.surface === 'seat');
    expect(seated.length).toBeGreaterThan(0);
    const handed = seated[seated.length - 1].replyBounds as Record<string, unknown>;
    expect(handed.safeTop).toBe(66);
    expect(handed.barrierTop).toEqual(expect.any(Number));
    expect(handed.boundsLeft).toEqual(expect.any(Number));
    expect(handed.boundsRight).toEqual(expect.any(Number));
  });
});

// ── 11. Model-audio mode at the shell ────────────────────────────────────────

describe('LauncherShell — model-audio mode (#2897 ST-4)', () => {
  const SETTINGS = {
    id: 'settings',
    name: 'Settings',
    icon: () => null,
  } as unknown as FredoFeatureClass;

  const input = () => screen.getByRole('searchbox') as BarField;

  const renderShell = () => {
    const onOpenFeature = vi.fn();
    renderWithChakra(<LauncherShell showableFeatures={[SETTINGS]} onOpenFeature={onOpenFeature} />);
    return onOpenFeature;
  };

  const emitState = (payload: Record<string, unknown>) =>
    act(() => {
      emit('stt:state', { code: null, detail: null, origin: 'launcher', ...payload });
    });

  it('renders the MODEL listening chip (never the shipped `Listening` chip) and the model placeholder', () => {
    renderShell();
    emitState({ listening: true, phase: 'capturing' });

    const chip = screen.getByTestId('launcher-command-model-listening-chip');
    expect(chip).toHaveTextContent('Fredo is listening');
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(input()).toHaveAttribute('placeholder', 'release Space to finish');
    expect(screen.queryByTestId('launcher-command-hint')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByText('Listening')).toBeNull();
    expect(screen.getByTestId('launcher-command-listening-stop')).toHaveAttribute(
      'aria-label',
      'Stop listening',
    );
    expect(screen.getByTestId('launcher-command-listening-cancel')).toHaveAttribute(
      'aria-label',
      'Cancel dictation',
    );
  });

  it('renders the MODEL processing chip with NO stop/cancel once the stop delivered the clip', () => {
    renderShell();
    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });

    const chip = screen.getByTestId('launcher-command-model-processing-chip');
    expect(chip).toHaveTextContent('Fredo is processing your speech…');
    expect(input()).toHaveAttribute('placeholder', 'Fredo is processing…');
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-cancel')).toBeNull();
    expect(screen.queryByTestId('launcher-command-model-listening-chip')).toBeNull();
  });

  it('the bar keeps the typed draft and the transcript announcer stays EMPTY', () => {
    const onOpenFeature = renderShell();

    act(() => {
      fireEvent.change(input(), { target: { value: 'draft I typed' } });
    });
    emitState({ listening: true, phase: 'capturing' });

    expect(input().value).toBe('draft I typed');
    const transcriptAnnouncer = screen.getByTestId('voice-transcript-announcer');
    expect(transcriptAnnouncer).toBeInTheDocument();
    expect(transcriptAnnouncer.textContent).toBe('');

    emitState({ listening: false, phase: 'processing' });
    expect(input().value).toBe('draft I typed');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(onOpenFeature).not.toHaveBeenCalled();
  });

  it('announces the model transitions ONCE each: `Fredo is listening`, then `Fredo is processing your speech`', () => {
    renderShell();
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('');

    emitState({ listening: true, phase: 'capturing' });
    expect(announcer).toHaveTextContent('Fredo is listening');

    emitState({ listening: true, phase: 'capturing' });
    expect(announcer).toHaveTextContent('Fredo is listening');

    emitState({ listening: false, phase: 'processing' });
    expect(announcer).toHaveTextContent('Fredo is processing your speech');
    expect(announcer).not.toHaveTextContent('Stopped listening');
  });
});

// ── 12. The model-audio delivery glue + the text-only failure alert ──────────

describe('LauncherShell — model-audio delivery glue (#2897 ST-6)', () => {
  const input = () => screen.getByRole('searchbox') as BarField;

  const emitState = (payload: Record<string, unknown>) =>
    act(() => {
      emit('stt:state', { code: null, detail: null, origin: 'launcher', ...payload });
    });

  const CLIP = {
    base64: 'QUJD',
    format: 'wav',
    sampleRate: 16000,
    durationMs: 100,
    limitMs: 30000,
    atLimit: false,
    truncated: false,
  };

  const installInvoke = (clipResult: unknown) => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'stt_start') return okStart();
      if (command === 'stt_take_audio_clip') return clipResult;
      return undefined;
    });
    adapterBridge.setInvoke(invoke as never);
    return invoke;
  };

  const renderShell = () =>
    renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);

  it('takes the clip and dispatches it EXACTLY ONCE per session, re-arming on the next capture', async () => {
    const invoke = installInvoke({ clip: CLIP, code: null, detail: null });
    renderShell();

    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });

    await waitFor(() => {
      expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledTimes(1);
    });
    expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledWith('QUJD');
    expect(
      invoke.mock.calls.filter((call) => call[0] === 'stt_take_audio_clip').length,
    ).toBe(1);

    emitState({ listening: false, phase: 'processing' });
    await act(async () => {});
    expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledTimes(1);

    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });
    await waitFor(() => {
      expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledTimes(2);
    });
  });

  it('clears the processing chip once the audio turn settles, and re-arms on a new capture', async () => {
    installInvoke({ clip: CLIP, code: null, detail: null });
    const shell = () => <LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />;
    const { rerender } = renderWithChakra(shell());

    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });
    await waitFor(() => {
      expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTestId('launcher-command-model-processing-chip')).toBeInTheDocument();

    companionMock.current.replyInFlight = true;
    act(() => {
      rerender(shell());
    });
    expect(screen.getByTestId('launcher-command-model-processing-chip')).toBeInTheDocument();

    companionMock.current.replyInFlight = false;
    act(() => {
      rerender(shell());
    });
    expect(screen.queryByTestId('launcher-command-model-processing-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-model-listening-chip')).toBeNull();
    expect(input()).toHaveAttribute('placeholder', 'search or command');

    emitState({ listening: true, phase: 'capturing' });
    expect(screen.queryByTestId('launcher-command-model-processing-chip')).toBeNull();
    emitState({ listening: false, phase: 'processing' });
    expect(screen.getByTestId('launcher-command-model-processing-chip')).toBeInTheDocument();
  });

  it('never writes the bar through the glue path and never dispatches a text turn', async () => {
    installInvoke({ clip: CLIP, code: null, detail: null });
    renderShell();

    act(() => {
      fireEvent.change(input(), { target: { value: 'draft I typed' } });
    });
    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });

    await waitFor(() => {
      expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledTimes(1);
    });
    expect(input().value).toBe('draft I typed');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
  });

  it('dispatches the model-audio turn through the skill-aware path (#2903)', async () => {
    const invoke = installInvoke({ clip: CLIP, code: null, detail: null });
    renderShell();

    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });

    await waitFor(() => {
      expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledTimes(1);
    });
    expect(companionDispatchMock.askActiveCompanionWithAudio).toHaveBeenCalledWith('QUJD');
    expect(companionDispatchMock.askActiveCompanion).not.toHaveBeenCalled();
    expect(
      invoke.mock.calls.filter((call) => call[0] === 'stt_take_audio_clip').length,
    ).toBe(1);
  });

  it('a NULL clip surfaces the generic alert with NO local-switch action (one path — the fallback is gone)', async () => {
    installInvoke({ clip: null, code: null, detail: null });
    renderShell();

    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });

    await waitFor(() => {
      expect(screen.getByTestId('launcher-command-listening-status')).toHaveTextContent(
        "Fredo couldn't interpret that recording.",
      );
    });
    expect(companionDispatchMock.askActiveCompanionWithAudio).not.toHaveBeenCalled();
    expect(screen.getByTestId('launcher-command-listening-status')).toHaveAttribute(
      'role',
      'alert',
    );
    // Spec #2914 ST-5 — the inline `Use local transcription` fallback is deleted.
    expect(screen.queryByTestId('launcher-command-listening-status-action')).toBeNull();
  });

  it('a dispatch rejection surfaces the curated alert', async () => {
    installInvoke({ clip: CLIP, code: null, detail: null });
    companionDispatchMock.askActiveCompanionWithAudio.mockReturnValue({
      outcome: 'rejected',
    });
    renderShell();

    emitState({ listening: true, phase: 'capturing' });
    emitState({ listening: false, phase: 'processing' });

    await waitFor(() => {
      expect(screen.getByTestId('launcher-command-listening-status')).toHaveTextContent(
        "Fredo couldn't interpret that recording.",
      );
    });
  });

  it('the typed `modelAudioUnsupported` wire code carries CURATED copy (never the raw IPC string)', () => {
    renderShell();

    emitState({
      listening: false,
      code: 'modelAudioUnsupported',
      detail: 'the model server rejected the audio input (HTTP 400)',
    });

    const alert = screen.getByTestId('launcher-command-listening-status');
    expect(alert).toHaveTextContent("can't interpret audio");
    expect(alert).not.toHaveTextContent('HTTP 400');
    // The deleted local-transcription shortcut leaves a text-only alert.
    expect(screen.queryByTestId('launcher-command-listening-status-action')).toBeNull();
  });

  it('the typed `modelAudioUnavailable` wire code carries the server-not-running copy', () => {
    renderShell();

    emitState({
      listening: false,
      code: 'modelAudioUnavailable',
      detail: 'connection refused',
    });

    const alert = screen.getByTestId('launcher-command-listening-status');
    expect(alert).toHaveTextContent("local model server isn't running");
    expect(alert).not.toHaveTextContent('connection refused');
  });
});
