/**
 * Spec #2877 ST-6 — `CompanionListeningBubble` (DR-8 / DR-10 / DR-11).
 *
 * The companion-origin listening affordance — the AC5 visible-capture surface
 * that closes the PO-case-1 headless-capture hole. Pins:
 *   1. R-5.3 — exactly ONE indicator per session: the bubble renders ONLY for a
 *      `stt:state.origin === 'companion'` session (a launcher-origin session is
 *      the bar cue's and never renders the bubble).
 *   2. DR-8 — the bubble carries the STATIC accent dot + `Listening…` + a clamped
 *      transcript preview + a Stop control (`aria-label="Stop listening"`).
 *   3. Stop invokes `stt_stop` through the shared ST-3 client (never raw events).
 *   4. DR-11 — the hearing-nothing hint after `HEARING_NOTHING_MS`; a curated
 *      `role="alert"` for a companion-origin start/engine failure (the raw
 *      backend detail is never the primary sentence).
 *   5. DR-12 — the visible preview is ordinary DOM text (never `aria-live`), and
 *      the source is token-first (no hardcoded hex/rgba, no alpha-append onto a
 *      var() reference).
 *
 * The hook is mocked at the `adapterBridge` boundary (the same pattern as
 * `launcherVoiceDictation.test.tsx`), so the REAL `useVoiceDictation` merge /
 * state machine is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  CompanionListeningBubble,
  HEARING_NOTHING_COPY,
  HEARING_NOTHING_MS,
  companionVoiceErrorCopy,
} from '../CompanionListeningBubble';

type Handler = (payload: unknown) => void;

let handlers: Record<string, Handler[]>;
let invokeSpy: ReturnType<typeof vi.fn>;

const emit = (event: string, payload: unknown) => {
  (handlers[event] ?? []).forEach((handler) => handler(payload));
};

beforeEach(() => {
  handlers = {};
  invokeSpy = vi.fn(async () => undefined);
  adapterBridge.setInvoke(invokeSpy as never);
  adapterBridge.setListen((async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    return () => {};
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
});

const renderBubble = (surface: 'seat' | 'overlay' = 'seat') =>
  renderWithChakra(<CompanionListeningBubble surface={surface} />);

const emitState = (
  listening: boolean,
  origin: string | null,
  code: string | null = null,
  detail: string | null = null,
) =>
  act(() => {
    emit('stt:state', { listening, code, detail, origin });
  });

let revision = 0;
const emitTranscript = (text: string, isFinal = false) =>
  act(() => {
    emit('stt:transcript', {
      sessionId: 's',
      revision: ++revision,
      segmentId: 0,
      text,
      isFinal,
      latencyMs: 1,
    });
  });

describe('#2877 ST-6 — companion listening bubble (R-5.3 / DR-8)', () => {
  it('renders nothing before any session', () => {
    renderBubble();
    expect(screen.queryByTestId('companion-listening-bubble')).toBeNull();
  });

  it('R-5.3: a LAUNCHER-origin session never renders the bubble (the bar cue owns it)', () => {
    renderBubble();
    emitState(true, 'launcher');
    expect(screen.queryByTestId('companion-listening-bubble')).toBeNull();
  });

  it('DR-8: a COMPANION-origin session renders the dot + Listening… + Stop', () => {
    renderBubble();
    emitState(true, 'companion');

    const bubble = screen.getByTestId('companion-listening-bubble');
    expect(bubble).toBeInTheDocument();
    expect(screen.getByTestId('companion-listening-dot')).toBeInTheDocument();
    expect(bubble).toHaveTextContent('Listening…');
    expect(screen.getByTestId('companion-listening-stop')).toHaveAttribute(
      'aria-label',
      'Stop listening',
    );
  });

  it('F-38: a corrected duplicate-start re-emit keeps the dot + Stop (never the error variant)', () => {
    renderBubble();
    emitState(true, 'companion');
    expect(screen.getByTestId('companion-listening-dot')).toBeInTheDocument();
    expect(screen.getByTestId('companion-listening-stop')).toBeInTheDocument();

    // ST-1's corrected duplicate-start emission is the TRUE live state — the
    // same shape as the original start (`listening:true`, active
    // `origin:'companion'`). It must never flip the bubble to `showError`.
    emitState(true, 'companion', null, null);

    expect(screen.getByTestId('companion-listening-bubble')).toBeInTheDocument();
    expect(screen.getByTestId('companion-listening-dot')).toBeInTheDocument();
    expect(screen.getByTestId('companion-listening-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-listening-error')).toBeNull();
  });

  it('F-38: a re-emit that still carries alreadyListening cannot flip a LIVE session to the error variant', () => {
    // Belt-and-braces for the frontend half: while `listening:true` the code is
    // ignored (the hook nulls it), so a partially-corrected backend emission can
    // never blank the indicator mid-session (R-5.3).
    renderBubble();
    emitState(true, 'companion');
    emitState(true, 'companion', 'alreadyListening', 'A listening session is already active.');

    expect(screen.getByTestId('companion-listening-dot')).toBeInTheDocument();
    expect(screen.getByTestId('companion-listening-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-listening-error')).toBeNull();
  });

  it('Stop invokes stt_stop (backend-authoritative, idempotent)', () => {
    renderBubble();
    emitState(true, 'companion');

    act(() => {
      fireEvent.click(screen.getByTestId('companion-listening-stop'));
    });

    expect(invokeSpy).toHaveBeenCalledWith('stt_stop', undefined);
  });

  it('clears when the session stops', () => {
    renderBubble();
    emitState(true, 'companion');
    expect(screen.getByTestId('companion-listening-bubble')).toBeInTheDocument();

    emitState(false, 'companion');
    expect(screen.queryByTestId('companion-listening-bubble')).toBeNull();
  });

  it('shows the live transcript preview as ordinary DOM text (never a live region)', () => {
    renderBubble();
    emitState(true, 'companion');
    emitTranscript('hello world');

    const preview = screen.getByTestId('companion-listening-preview');
    expect(preview).toHaveTextContent('hello world');
    expect(preview).not.toHaveAttribute('aria-live');
  });

  it('keeps the NEWEST text visible in the clamped preview', () => {
    renderBubble();
    emitState(true, 'companion');
    const long = `${'a'.repeat(200)} newest words`;
    emitTranscript(long);

    const preview = screen.getByTestId('companion-listening-preview');
    expect(preview).toHaveTextContent('newest words');
    expect(preview.textContent ?? '').not.toContain('a'.repeat(160));
  });

  it('renders the seat anchor above the slot and the overlay anchor viewport-fixed', () => {
    const seat = renderBubble('seat');
    emitState(true, 'companion');
    const seatBubble = screen.getByTestId('companion-listening-bubble');
    expect(seatBubble.style.position).toBe('absolute');
    seat.unmount();

    renderBubble('overlay');
    emitState(true, 'companion');
    const overlayBubble = screen.getByTestId('companion-listening-bubble');
    expect(overlayBubble.style.position).toBe('fixed');
  });
});

describe('#2877 ST-6 — hearing-nothing + error states (DR-11)', () => {
  it('shows the hearing-nothing hint after HEARING_NOTHING_MS of silence', () => {
    vi.useFakeTimers();
    renderBubble();
    emitState(true, 'companion');
    expect(screen.queryByTestId('companion-listening-status')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(HEARING_NOTHING_MS);
    });

    expect(screen.getByTestId('companion-listening-status')).toHaveTextContent(
      HEARING_NOTHING_COPY,
    );
  });

  it('never shows the hearing-nothing hint once text arrives', () => {
    vi.useFakeTimers();
    renderBubble();
    emitState(true, 'companion');
    emitTranscript('hi there');

    act(() => {
      vi.advanceTimersByTime(HEARING_NOTHING_MS);
    });

    expect(screen.queryByTestId('companion-listening-status')).toBeNull();
  });

  it('renders a role=alert with curated copy for a companion-origin failure', () => {
    renderBubble();
    emitState(false, 'companion', 'modelMissing', 'raw ipc string');

    expect(screen.getByTestId('companion-listening-bubble')).toBeInTheDocument();
    const alert = screen.getByTestId('companion-listening-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent("Voice input model isn't ready");
    expect(alert).not.toHaveTextContent('raw ipc string');
  });

  it('never renders the bubble for a LAUNCHER-origin failure', () => {
    renderBubble();
    emitState(false, 'launcher', 'modelMissing', 'raw ipc string');
    expect(screen.queryByTestId('companion-listening-bubble')).toBeNull();
  });

  it('companionVoiceErrorCopy maps every typed failure code and is null on success', () => {
    for (const code of [
      'permissionDenied',
      'noDevice',
      'modelMissing',
      'modelCorrupt',
      'engineStartFailed',
    ] as const) {
      const copy = companionVoiceErrorCopy(code);
      expect(copy).toBeTruthy();
      expect(copy).not.toContain(code);
    }
    expect(companionVoiceErrorCopy(null)).toBeNull();
  });
});

describe('#2877 ST-6 — token contract (DR-12, static source pin)', () => {
  const BUBBLE_PATH = 'src/shared/components/companion/CompanionListeningBubble.tsx';

  /** vitest runs with cwd = apps/ui (the package root). */
  const source = () => readFileSync(resolve(process.cwd(), BUBBLE_PATH), 'utf8');

  it('never alpha-appends onto a var() and uses no hardcoded hex/rgba', () => {
    const src = source();
    expect(src).not.toMatch(/var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(src).not.toMatch(/rgba?\(/);
  });

  it('routes the accent-tinted border through the shared tint() helper', () => {
    expect(source()).toContain("tint('var(--accent-primary)', 30)");
  });
});
