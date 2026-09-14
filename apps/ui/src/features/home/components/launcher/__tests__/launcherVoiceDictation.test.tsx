/**
 * SPIKE #2876 ST-4 — THROWAWAY POC tests (replaced by #2877/#2878).
 *
 * Pins:
 *   1. `selectCtrlSpaceAction` — the binding context-dependent Ctrl+Space
 *      cascade (carve-out first; companion-away pre-empts bar-focused; else
 *      open WITHOUT listening), pure.
 *   2. The document listener wiring: bar-focused → launcher listening;
 *      companion-away → companion listening; default → open (no listen).
 *   3. Escape cancels a live dictation session BEFORE the launcher close.
 *   4. The EXISTING bar input value tracks the live transcript (and never
 *      submits / clears).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  LauncherShell,
  selectCtrlSpaceAction,
  type CtrlSpaceContext,
} from '../LauncherShell';

// LauncherShell reads the live connection flag via useConnectionStatus (no
// StreamProvider in this isolated harness) — stub the one consumer.
vi.mock('@/shared/contexts/StreamContext', () => ({
  useConnectionStatus: () => ({ isConnected: true }),
}));

// Companion presence is host-derived from `useCompanion`; a hoisted mutable
// state lets each case pick seated / away / off without re-mocking the module.
const companionState = vi.hoisted(() => ({
  current: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
}));
vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => ({ state: companionState.current }),
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
  companionState.current = {
    isVisible: false,
    isAway: false,
    isAutoHidden: false,
    isInUse: false,
  };
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
});

// ── 2-4. LauncherShell wiring ────────────────────────────────────────────────

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

  it('case 2: Ctrl+Space with the bar focused starts a LAUNCHER session', () => {
    renderShell();
    const input = screen.getByRole('searchbox');
    act(() => {
      input.focus();
      fireEvent.focus(input);
    });

    ctrlSpace();

    expect(invokeSpy).toHaveBeenCalledWith('stt_start', { origin: 'launcher' });
  });

  it('case 1: Ctrl+Space with the companion away starts a COMPANION session', () => {
    companionState.current = {
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
    act(() => {
      emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    });
    const input = screen.getByRole('searchbox');
    act(() => {
      input.focus();
      fireEvent.focus(input);
    });

    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_cancel', undefined);
  });

  it('the bar input tracks the live transcript (partial → partial → final) and never submits', () => {
    const onOpenFeature = renderShell();

    act(() => {
      emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    });
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

    act(() => {
      emit('stt:state', { listening: true, code: null, detail: null, origin: 'launcher' });
    });
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
  });
});
