/**
 * CompanionContext presence-lifecycle unit tests — Spec #2853 ST-6.
 *
 * Pins the binding `## Software Architect` §API Contracts for the idle
 * auto-return presence lifecycle (ST-1/ST-2/ST-3):
 *
 *   1. `clampIdleTimeout` — default on cleared/empty/NaN/<=0, below-min →
 *      MIN, above-max → MAX, fractional round, in-range passthrough.
 *   2. Host-scoped idle timer — arms ONLY while designated present in the
 *      hosting window (`isVisible && isHosting && !isAutoHidden &&
 *      !isAutoReturning`); on fire it dispatches AUTO_RETURN_REQUESTED
 *      (in-flight) — NEVER AUTO_RETURN_SETTLED / SET_AUTO_HIDDEN; it does not
 *      run while hidden or in a non-host window.
 *   3. Interaction resets (ST-3) — `notifyInteraction()` re-arms the timer and
 *      cancels an in-flight return so a mid-leave-motion interaction recalls
 *      Fredo.
 *   4. `AUTO_RETURN_SETTLED` (confirmAutoReturn) → `isAutoHidden:true`,
 *      `isAutoReturning:false`; `SET_VISIBLE(true)` clears BOTH transient flags.
 *   5. Cross-window `SYNC_PRESENCE` → applies visible/autoHidden + clears
 *      isAutoReturning WITHOUT persisting (setVisible is the sole persisted
 *      writer — asserted via a `settingsService.set` spy).
 *   6. Presence derivation — designated presence = `isVisible && !isAutoHidden`.
 *   7. Continuous "in use" suppression (ST-3 round 2) — `isInUse` clears/re-arms
 *      the host idle timer, never arms without designated presence, and is
 *      transient (never persisted via `settingsService.set`).
 *
 * The Tauri branch (`IS_TAURI`) is forced ON at module-eval time via
 * `vi.hoisted` so the `companion-presence` listener registers; the event module
 * is mocked so no real Tauri host is needed and the handler can be driven
 * directly. Fake timers are used for every countdown (no real waits).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionProvider,
  useCompanion,
  clampIdleTimeout,
  DEFAULT_IDLE_TIMEOUT_S,
  MIN_IDLE_TIMEOUT_S,
  MAX_IDLE_TIMEOUT_S,
  IDLE_TIMEOUT_SETTING_KEY,
  WELCOME_TEXT,
  clampReplyLeaveGraceMs,
  DEFAULT_REPLY_LEAVE_GRACE_MS,
  MIN_REPLY_LEAVE_GRACE_MS,
  MAX_REPLY_LEAVE_GRACE_MS,
  REPLY_LEAVE_GRACE_STEP_MS,
  COMPANION_SEND_DURING_REPLY_KEY,
  DEFAULT_COMPANION_SEND_DURING_REPLY,
  REPLY_LEAVE_GRACE_SETTING_KEY,
} from '@/shared/contexts/CompanionContext';
import type { CompanionSendDisposition } from '@/shared/contexts/CompanionContext';
import { settingsService } from '@/features/settings';
import { adapterBridge } from '@/shared/utils/adapterBridge';

// ── Module mocks / environment ──────────────────────────────────────────────
//
// `vi.hoisted` runs BEFORE the static imports are evaluated, so the module-level
// `IS_TAURI` const in CompanionContext observes the flag as set here.
vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    // Functional stub: if any real @tauri-apps/api path escapes the mock, it
    // resolves harmlessly instead of throwing an unhandled rejection.
    invoke: async () => undefined,
    transformCallback: (cb: unknown, once = false) => {
      const id = Math.floor(Math.random() * 1_000_000_000);
      const key = `_${id}`;
      (window as unknown as Record<string, unknown>)[key] = (payload: unknown) => {
        if (once) delete (window as unknown as Record<string, unknown>)[key];
        (cb as (p: unknown) => void)(payload);
      };
      return id;
    },
    convertFileSrc: (filePath: string) => filePath,
    metadata: {},
  };
});

const tauriEvent = vi.hoisted(() => ({
  emit: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (ev: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: tauriEvent.emit,
  listen: tauriEvent.listen,
}));

// ── Probe ────────────────────────────────────────────────────────────────────

type CompanionApi = ReturnType<typeof useCompanion>;
let api: CompanionApi;

function PresenceProbe() {
  api = useCompanion();
  const { isVisible, isAway, isAutoHidden, isAutoReturning, isHosting, isInUse, message, messageDuration } = api.state;
  return (
    <div
      data-testid="presence"
      data-visible={String(isVisible)}
      data-away={String(isAway)}
      data-autohidden={String(isAutoHidden)}
      data-autoreturning={String(isAutoReturning)}
      data-hosting={String(isHosting)}
      data-inuse={String(isInUse)}
      data-present={String(isVisible && !isAutoHidden)}
      data-message={message ?? ''}
      data-message-duration={String(messageDuration)}
      data-idle-timeout={String(api.idleTimeoutSeconds)}
      data-send-during-reply={api.sendDuringReply}
      data-reply-leave-grace={String(api.replyLeaveGraceMs)}
      data-reply-in-flight={String(api.replyInFlight)}
      data-queued-send-count={String(api.queuedSendCount)}
    />
  );
}

function presence() {
  const el = screen.getByTestId('presence');
  return {
    visible: el.getAttribute('data-visible') === 'true',
    away: el.getAttribute('data-away') === 'true',
    autoHidden: el.getAttribute('data-autohidden') === 'true',
    autoReturning: el.getAttribute('data-autoreturning') === 'true',
    hosting: el.getAttribute('data-hosting') === 'true',
    inUse: el.getAttribute('data-inuse') === 'true',
    present: el.getAttribute('data-present') === 'true',
    message: el.getAttribute('data-message') ?? '',
    messageDuration: Number(el.getAttribute('data-message-duration')),
    sendDuringReply: (el.getAttribute('data-send-during-reply') ?? '') as CompanionSendDisposition | '',
    replyLeaveGraceMs: Number(el.getAttribute('data-reply-leave-grace')),
    replyInFlight: el.getAttribute('data-reply-in-flight') === 'true',
    queuedSendCount: Number(el.getAttribute('data-queued-send-count')),
  };
}

/** Deliver a `companion-presence` broadcast into the registered handler. */
function deliverPresence(payload: Record<string, unknown>) {
  const handler = tauriEvent.handlers.get('companion-presence');
  if (!handler) throw new Error('companion-presence listener was not registered');
  act(() => { handler({ payload }); });
}

/**
 * Mount the real provider + probe, seed the persisted keys, and flush BOTH
 * async persisted-setting loads so the timer gate sees the final values.
 *
 * `seedSendDuringReply`/`seedGraceMs` are RAW stored strings for the #2892 ST-1
 * healing legs; omit them for the default-value legs.
 */
async function mountProvider({
  visible,
  timeoutS = 5,
  seedSendDuringReply,
  seedGraceMs,
}: {
  visible: boolean;
  timeoutS?: number;
  seedSendDuringReply?: string;
  seedGraceMs?: string;
}) {
  localStorage.clear();
  localStorage.setItem(IDLE_TIMEOUT_SETTING_KEY, String(timeoutS));
  if (visible) localStorage.setItem('Fredo_companion_visible', 'true');
  if (seedSendDuringReply !== undefined) {
    localStorage.setItem(COMPANION_SEND_DURING_REPLY_KEY, seedSendDuringReply);
  }
  if (seedGraceMs !== undefined) {
    localStorage.setItem(REPLY_LEAVE_GRACE_SETTING_KEY, seedGraceMs);
  }

  const view = renderWithChakra(
    <CompanionProvider>
      <PresenceProbe />
    </CompanionProvider>,
  );

  const expectedDisposition: CompanionSendDisposition =
    seedSendDuringReply === 'interrupt' ? 'interrupt' : DEFAULT_COMPANION_SEND_DURING_REPLY;
  const expectedGraceMs = seedGraceMs === undefined
    ? DEFAULT_REPLY_LEAVE_GRACE_MS
    : clampReplyLeaveGraceMs(Number(seedGraceMs));

  await waitFor(() => {
    expect(screen.getByTestId('presence').getAttribute('data-visible')).toBe(String(visible));
    expect(screen.getByTestId('presence').getAttribute('data-idle-timeout')).toBe(String(timeoutS));
    // Flush the two #2892 ST-1 async persisted loads as well.
    expect(screen.getByTestId('presence').getAttribute('data-send-during-reply')).toBe(expectedDisposition);
    expect(screen.getByTestId('presence').getAttribute('data-reply-leave-grace')).toBe(String(expectedGraceMs));
  });

  // Flush the presence-listener registration microtask chain.
  await act(async () => {});
  return view;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
  // Keep `__TAURI_INTERNALS__` set (IS_TAURI is module-scoped), but stub the
  // invoke bridge so `settingsService` never touches a real host.
  adapterBridge.setInvoke(async () => undefined);
  tauriEvent.handlers.clear();
  tauriEvent.listen.mockImplementation((event: string, handler: (ev: { payload: unknown }) => void) => {
    tauriEvent.handlers.set(event, handler);
    return Promise.resolve(() => { tauriEvent.handlers.delete(event); });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

// ── 1. clampIdleTimeout (ST-1 contract) ──────────────────────────────────────

describe('clampIdleTimeout — persisted idle-timeout guard (#2853 ST-1)', () => {
  it('falls back to the 60 s default for cleared/empty/non-numeric/<=0 values', () => {
    expect(DEFAULT_IDLE_TIMEOUT_S).toBe(60);
    expect(clampIdleTimeout(Number(''))).toBe(DEFAULT_IDLE_TIMEOUT_S);      // cleared field
    expect(clampIdleTimeout(Number('   '))).toBe(DEFAULT_IDLE_TIMEOUT_S);   // whitespace
    expect(clampIdleTimeout(Number('abc'))).toBe(DEFAULT_IDLE_TIMEOUT_S);   // non-numeric
    expect(clampIdleTimeout(Number.NaN)).toBe(DEFAULT_IDLE_TIMEOUT_S);
    expect(clampIdleTimeout(0)).toBe(DEFAULT_IDLE_TIMEOUT_S);
    expect(clampIdleTimeout(-30)).toBe(DEFAULT_IDLE_TIMEOUT_S);
    expect(clampIdleTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_IDLE_TIMEOUT_S);
    expect(clampIdleTimeout(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_IDLE_TIMEOUT_S);
  });

  it('clamps below-min values up to 5 s', () => {
    expect(MIN_IDLE_TIMEOUT_S).toBe(5);
    expect(clampIdleTimeout(1)).toBe(MIN_IDLE_TIMEOUT_S);
    expect(clampIdleTimeout(4.4)).toBe(MIN_IDLE_TIMEOUT_S);
  });

  it('clamps above-max values down to 3600 s', () => {
    expect(MAX_IDLE_TIMEOUT_S).toBe(3600);
    expect(clampIdleTimeout(99999)).toBe(MAX_IDLE_TIMEOUT_S);
    expect(clampIdleTimeout(1_000_000)).toBe(MAX_IDLE_TIMEOUT_S);
  });

  it('rounds fractional values', () => {
    expect(clampIdleTimeout(30.4)).toBe(30);
    expect(clampIdleTimeout(30.6)).toBe(31);
    expect(clampIdleTimeout(4.6)).toBe(MIN_IDLE_TIMEOUT_S); // rounds to 5, at min
  });

  it('passes in-range integers through unchanged', () => {
    expect(clampIdleTimeout(5)).toBe(5);
    expect(clampIdleTimeout(30)).toBe(30);
    expect(clampIdleTimeout(60)).toBe(60);
    expect(clampIdleTimeout(3600)).toBe(3600);
  });
});

// ── 2. Host-scoped idle timer (ST-2) ─────────────────────────────────────────

describe('CompanionProvider — host-scoped idle auto-return timer (#2853 ST-2)', () => {
  it('arms only at the deadline and fires AUTO_RETURN_REQUESTED (in-flight), never settling directly', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });

    // Just under the configured timeout: no premature return.
    act(() => { vi.advanceTimersByTime(4_999); });
    expect(presence().autoReturning).toBe(false);
    expect(presence().autoHidden).toBe(false);

    // At the deadline: the timer REQUESTS the leave motion — it must NOT settle.
    act(() => { vi.advanceTimersByTime(1); });
    expect(presence().autoReturning).toBe(true);
    expect(presence().autoHidden).toBe(false);
    expect(presence().visible).toBe(true, 'the persisted preference is untouched by the request');
    expect(presence().present).toBe(true, 'still designated present until the settle');
  });

  it('does NOT run the timer while hidden by preference (no designated presence)', async () => {
    await mountProvider({ visible: false, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); }); // hosting, but not visible
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(presence().visible).toBe(false);
    expect(presence().autoReturning).toBe(false);
  });

  it('does NOT run the timer in a non-host window', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    // `isHosting` stays false (this webview does not display the companion).
    expect(presence().hosting).toBe(false);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(presence().autoReturning).toBe(false);
    expect(presence().autoHidden).toBe(false);
  });

  it('does NOT run the timer while already auto-hidden (settled)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    act(() => { api.confirmAutoReturn(); });
    expect(presence().autoHidden).toBe(true);

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(presence().autoReturning).toBe(false, 'no late AUTO_RETURN_REQUESTED while hidden');
    expect(presence().autoHidden).toBe(true);
  });
});

// ── 3. Interaction resets (ST-3) ─────────────────────────────────────────────

describe('CompanionProvider — notifyInteraction resets (#2853 ST-3)', () => {
  it('re-arms the timer so the return is deferred by a full quiet period', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(4_000); }); // 4 s elapsed
    act(() => { api.notifyInteraction(); });       // reset at t = 4 s

    act(() => { vi.advanceTimersByTime(4_000); }); // t = 8 s → only 4 s since reset
    expect(presence().autoReturning).toBe(false);

    act(() => { vi.advanceTimersByTime(1_000); }); // t = 9 s → 5 s since reset
    expect(presence().autoReturning).toBe(true);
  });

  it('cancels an in-flight auto-return so an interaction during the leave motion recalls Fredo', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(presence().autoReturning).toBe(true);

    act(() => { api.notifyInteraction(); });
    expect(presence().autoReturning).toBe(false, 'the pending return is cancelled');
    expect(presence().autoHidden).toBe(false);
    expect(presence().present).toBe(true);
  });

  it('is a no-op while hidden (no timer to arm, no state churn)', async () => {
    await mountProvider({ visible: false, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { api.notifyInteraction(); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(presence().autoReturning).toBe(false);
    expect(presence().visible).toBe(false);
  });
});

// ── 4. Settle + re-show (ST-2 / AC-5) ────────────────────────────────────────

describe('CompanionProvider — settle + re-show transitions (#2853 ST-2)', () => {
  it('AUTO_RETURN_SETTLED sets isAutoHidden and clears isAutoReturning', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    act(() => { api.confirmAutoReturn(); });

    expect(presence().autoHidden).toBe(true);
    expect(presence().autoReturning).toBe(false);
    expect(presence().visible).toBe(true, 'the persisted preference remains ON (AC-5)');
    expect(presence().present).toBe(false);
  });

  it('setVisible(true) clears BOTH transient flags and writes the persisted preference', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    act(() => { api.confirmAutoReturn(); });
    expect(presence().autoHidden).toBe(true);

    const setSpy = vi.spyOn(settingsService, 'set');
    act(() => { api.setVisible(true); });

    expect(presence().autoHidden).toBe(false);
    expect(presence().autoReturning).toBe(false);
    expect(presence().visible).toBe(true);
    expect(presence().present).toBe(true);
    expect(setSpy).toHaveBeenCalledWith('Fredo_companion_visible', 'true');
    setSpy.mockRestore();
  });

  it('setVisible broadcasts the global companion-presence event (apply-locally-then-broadcast)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });

    act(() => { api.setVisible(false); });

    // Local state applied first...
    expect(presence().visible).toBe(false);
    // ...then the global broadcast fires (same Tauri event channel as teleport).
    await waitFor(() => {
      expect(tauriEvent.emit).toHaveBeenCalledWith(
        'companion-presence',
        expect.objectContaining({ reason: 'hide', visible: false, autoHidden: false }),
      );
    });
  });
});

// ── 5. Cross-window SYNC_PRESENCE (ST-2) ─────────────────────────────────────

describe('CompanionProvider — cross-window SYNC_PRESENCE (#2853 ST-2)', () => {
  it('applies a remote idle-settle (isAutoHidden) WITHOUT persisting the preference', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    deliverPresence({ from: 'terminal', reason: 'idle-settle', autoHidden: true });

    expect(presence().autoHidden).toBe(true);
    expect(presence().visible).toBe(true, 'remote settle does not change the local preference');
    expect(presence().present).toBe(false);
    expect(setSpy).not.toHaveBeenCalled(); // no persist / echo loop
    setSpy.mockRestore();
  });

  it('applies a remote show (isVisible + clears isAutoHidden) WITHOUT persisting', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    deliverPresence({ from: 'terminal', reason: 'idle-settle', autoHidden: true });
    expect(presence().autoHidden).toBe(true);

    deliverPresence({ from: 'terminal', reason: 'show', visible: true, autoHidden: false });
    expect(presence().autoHidden).toBe(false);
    expect(presence().visible).toBe(true);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('clears a local in-flight auto-return when a remote presence arrives', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(presence().autoReturning).toBe(true);

    deliverPresence({ from: 'terminal', reason: 'show', visible: true, autoHidden: false });
    expect(presence().autoReturning).toBe(false);
    expect(presence().autoHidden).toBe(false);
  });

  it('a remote hide applies isVisible:false and clears the transient flags without persisting', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    deliverPresence({ from: 'terminal', reason: 'hide', visible: false, autoHidden: false });
    expect(presence().visible).toBe(false);
    expect(presence().autoHidden).toBe(false);
    expect(presence().autoReturning).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});

// ── 6. Designated-presence derivation ────────────────────────────────────────

describe('designated presence = isVisible && !isAutoHidden (#2853 ST-2)', () => {
  it('flips with the transient auto-hide while the persisted preference stays ON', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    expect(presence().present).toBe(true);

    vi.useFakeTimers();
    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    act(() => { api.confirmAutoReturn(); });

    expect(presence().present).toBe(false, 'auto-hidden → designated presence off (mascot returns)');
    expect(presence().visible).toBe(true, 'preference still ON');

    // Preference OFF → both store flags off, still not designated present.
    act(() => { api.setVisible(false); });
    expect(presence().visible).toBe(false);
    expect(presence().present).toBe(false);
  });
});

// ── 7. Continuous "in use" suppression (ST-3 round 2) ────────────────────────

describe('CompanionProvider — continuous "in use" suppression (#2853 ST-3 round 2)', () => {
  it('setInUse(true) clears a running timer so it does not fire at the deadline', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(4_000); }); // 4 s elapsed of a 5 s countdown
    act(() => { api.setInUse(true); });
    expect(presence().inUse).toBe(true);

    act(() => { vi.advanceTimersByTime(60_000); }); // way past the original deadline
    expect(presence().autoReturning).toBe(false, 'suppressed while continuously in use');
    expect(presence().autoHidden).toBe(false);
    expect(presence().visible).toBe(true);
  });

  it('setInUse(false) while designated-present re-arms a full quiet period', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { api.setInUse(true); });
    act(() => { vi.advanceTimersByTime(60_000); }); // held in use well past the deadline
    expect(presence().autoReturning).toBe(false);

    act(() => { api.setInUse(false); });
    // timeout − 1: the re-armed quiet period has not elapsed yet.
    act(() => { vi.advanceTimersByTime(4_999); });
    expect(presence().autoReturning).toBe(false);

    // +1 reaches the full quiet period → the leave motion is requested.
    act(() => { vi.advanceTimersByTime(1); });
    expect(presence().autoReturning).toBe(true);
    expect(presence().autoHidden).toBe(false);
  });

  it('isInUse alone does not arm a timer while hidden by preference (no fire)', async () => {
    await mountProvider({ visible: false, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); }); // hosting, but not designated present
    act(() => { api.setInUse(true); });
    act(() => { api.setInUse(false); }); // release must NOT arm without presence
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(presence().autoReturning).toBe(false);
    expect(presence().autoHidden).toBe(false);
    expect(presence().visible).toBe(false);
  });

  it('isInUse alone does not arm a timer in a non-host window (no fire)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    // `isHosting` stays false (this webview does not display the companion).
    expect(presence().hosting).toBe(false);
    act(() => { api.setInUse(true); });
    act(() => { api.setInUse(false); });
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(presence().autoReturning).toBe(false);
    expect(presence().autoHidden).toBe(false);
  });

  it('setInUse never writes a persisted setting (transient, host-local)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    act(() => { api.setInUse(true); });
    act(() => { api.setInUse(false); });

    expect(presence().inUse).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});

// ── 8. Canonical home/away location state (#2870 ST-1) ────────────────────────

describe('CompanionProvider — canonical location isAway (#2870 ST-1)', () => {
  it('teleport marks Fredo away and broadcasts companion-presence {reason: teleport, away: true}', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    expect(presence().away).toBe(false);

    act(() => { api.teleport(123, 456); });

    expect(presence().away).toBe(true);
    await waitFor(() => {
      expect(tauriEvent.emit).toHaveBeenCalledWith(
        'companion-presence',
        expect.objectContaining({ reason: 'teleport', away: true }),
      );
    });
  });

  // ── #2870 F-68: a relocation must clear any prior hide state ────────────────
  // After an idle auto-return the stale `isAutoHidden` must be cleared by the
  // next relocation, or the away overlay stays gated off AND the host idle gate
  // never re-arms → zero Fredos, stuck until a manual OFF/ON toggle.
  it('teleport after confirmAutoReturn clears isAutoHidden and the idle gate re-arms (F-68)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    act(() => { api.confirmAutoReturn(); });
    expect(presence().away).toBe(false);
    expect(presence().autoHidden).toBe(true);

    act(() => { api.teleport(300, 300); });
    expect(presence().away).toBe(true, 'teleport leaves the home seat');
    expect(presence().autoHidden).toBe(false, 'a relocation clears the prior hide state');
    expect(presence().autoReturning).toBe(false);

    // The host idle gate re-armed: a full quiet period requests the return again.
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(presence().autoReturning).toBe(true, 'the idle gate re-armed after the relocation');
  });

  it('teleport broadcast carries autoHidden:false so remote windows clear a stale hide (F-68)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });

    act(() => { api.teleport(123, 456); });

    await waitFor(() => {
      expect(tauriEvent.emit).toHaveBeenCalledWith(
        'companion-presence',
        expect.objectContaining({ reason: 'teleport', away: true, autoHidden: false }),
      );
    });
  });

  it('markAway marks Fredo away locally without persisting or broadcasting', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');
    tauriEvent.emit.mockClear();

    act(() => { api.markAway(); });

    expect(presence().away).toBe(true);
    expect(setSpy).not.toHaveBeenCalled();
    await act(async () => {});
    expect(tauriEvent.emit).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('markAway is idempotent (no state churn when already away)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    act(() => { api.markAway(); });
    const first = api.state;
    act(() => { api.markAway(); });
    expect(presence().away).toBe(true);
    expect(api.state).toBe(first, 'a redundant MARK_AWAY returns the same state object');
  });

  it('setVisible(true) brings Fredo home (SET_VISIBLE clears isAway)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    act(() => { api.teleport(300, 300); });
    expect(presence().away).toBe(true);

    act(() => { api.setVisible(true); });
    expect(presence().away).toBe(false);
  });

  it('setVisible(false) also clears isAway (role change returns him home)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    act(() => { api.teleport(300, 300); });
    expect(presence().away).toBe(true);

    act(() => { api.setVisible(false); });
    expect(presence().away).toBe(false);
    expect(presence().visible).toBe(false);
  });

  it('AUTO_RETURN_SETTLED returns Fredo home while auto-hidden (R-3/R-5)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.teleport(300, 300); });
    expect(presence().away).toBe(true);
    act(() => { api.setHosting(true); });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(presence().autoReturning).toBe(true);

    act(() => { api.confirmAutoReturn(); });
    expect(presence().away).toBe(false, 'the idle auto-return is a return to the seat');
    expect(presence().autoHidden).toBe(true);
    expect(presence().visible).toBe(true, 'the persisted preference stays ON');
  });

  it('broadcasts away:false on idle-settle so other windows re-occupy the seat', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });

    act(() => { api.confirmAutoReturn(); });

    await waitFor(() => {
      expect(tauriEvent.emit).toHaveBeenCalledWith(
        'companion-presence',
        expect.objectContaining({ reason: 'idle-settle', autoHidden: true, away: false }),
      );
    });
  });

  it('SYNC_PRESENCE applies a remote away/visible/autoHidden without persisting', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    deliverPresence({ from: 'terminal', reason: 'teleport', away: true });
    expect(presence().away).toBe(true);
    expect(presence().visible).toBe(true, 'a remote teleport leaves the local preference untouched');

    deliverPresence({ from: 'terminal', reason: 'idle-settle', autoHidden: true, away: false });
    expect(presence().away).toBe(false);
    expect(presence().autoHidden).toBe(true);
    expect(setSpy).not.toHaveBeenCalled(); // no persist / echo loop
    setSpy.mockRestore();
  });

  it('isAway is transient — a remote away never writes a persisted key', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    deliverPresence({ from: 'terminal', reason: 'teleport', away: true });
    deliverPresence({ from: 'terminal', reason: 'show', visible: true, autoHidden: false, away: false });

    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});

// ── 8b. Neutral position — no bottom-right corner default (#2870 ST-2b) ───────

describe('CompanionProvider — neutral position, no corner default (#2870 ST-2b)', () => {
  it('initializes position neutral (the bottom-right corner default is removed)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    expect(api.state.position).toEqual({ x: 0, y: 0 });
  });

  it('teleport is the only relocation source — it carries the supplied coordinates', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });

    act(() => { api.teleport(321, 234); });

    expect(api.state.position).toEqual({ x: 321, y: 234 });
    expect(presence().away).toBe(true);
  });
});

// ── 9. Welcome on OFF→ON turn-on (#2870 ST-1 / R-2) ──────────────────────────

describe('CompanionProvider — welcome on turn-on (#2870 ST-1 / R-2)', () => {
  it('shows WELCOME_TEXT for an explicit 4000 ms on the OFF→ON transition', async () => {
    await mountProvider({ visible: false, timeoutS: 5 });
    vi.useFakeTimers();
    expect(presence().message).toBe('');

    act(() => { api.setVisible(true); });

    expect(presence().message).toBe(WELCOME_TEXT);
    expect(presence().messageDuration).toBe(4000);
    expect(presence().visible).toBe(true);
    expect(presence().away).toBe(false);

    // Auto-hide only at the explicit 4 s duration (the single dismissTimerRef).
    act(() => { vi.advanceTimersByTime(3_999); });
    expect(presence().message).toBe(WELCOME_TEXT);
    act(() => { vi.advanceTimersByTime(1); });
    expect(presence().message).toBe('');
  });

  it('does not greet when a persisted ON preference is restored on mount', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    expect(presence().message).toBe('');
  });

  it('does not re-fire when setVisible(true) re-affirms an already-ON preference', async () => {
    await mountProvider({ visible: false, timeoutS: 5 });
    vi.useFakeTimers();

    act(() => { api.setVisible(true); });
    expect(presence().message).toBe(WELCOME_TEXT);
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(presence().message).toBe('');

    act(() => { api.setVisible(true); });
    expect(presence().message).toBe('', 'no second bubble on a re-affirmed ON');
  });

  it('produces no audio/TTS on turn-on (visual-only greeting)', async () => {
    const synth = (window as unknown as { speechSynthesis?: { speak: (u: unknown) => void } }).speechSynthesis;
    const speakSpy = synth ? vi.spyOn(synth, 'speak') : null;

    await mountProvider({ visible: false, timeoutS: 5 });
    act(() => { api.setVisible(true); });

    if (speakSpy) expect(speakSpy).not.toHaveBeenCalled();
    expect(presence().message).toBe(WELCOME_TEXT);
  });
});

// ── 10. Companion settings primitives (#2892 ST-1) ───────────────────────────

describe('#2892 ST-1 binding constants', () => {
  it('binds the exact persisted keys, default, range, and step', () => {
    expect(COMPANION_SEND_DURING_REPLY_KEY).toBe('Fredo_companion_send_during_reply');
    expect(DEFAULT_COMPANION_SEND_DURING_REPLY).toBe('queue');
    expect(REPLY_LEAVE_GRACE_SETTING_KEY).toBe('Fredo_companion_reply_leave_grace_ms');
    expect(DEFAULT_REPLY_LEAVE_GRACE_MS).toBe(2000);
    expect(MIN_REPLY_LEAVE_GRACE_MS).toBe(0);
    expect(MAX_REPLY_LEAVE_GRACE_MS).toBe(60000);
    expect(REPLY_LEAVE_GRACE_STEP_MS).toBe(250);
  });
});

describe('clampReplyLeaveGraceMs — persisted grace guard (#2892 ST-1)', () => {
  it('falls back to the 2000 ms default for non-finite values', () => {
    expect(DEFAULT_REPLY_LEAVE_GRACE_MS).toBe(2000);
    expect(clampReplyLeaveGraceMs(Number.NaN)).toBe(DEFAULT_REPLY_LEAVE_GRACE_MS);
    expect(clampReplyLeaveGraceMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_REPLY_LEAVE_GRACE_MS);
    expect(clampReplyLeaveGraceMs(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_REPLY_LEAVE_GRACE_MS);
  });

  it('clamps below-min values up to 0 ms', () => {
    expect(MIN_REPLY_LEAVE_GRACE_MS).toBe(0);
    expect(clampReplyLeaveGraceMs(-1)).toBe(MIN_REPLY_LEAVE_GRACE_MS);
    expect(clampReplyLeaveGraceMs(-5000)).toBe(MIN_REPLY_LEAVE_GRACE_MS);
  });

  it('clamps above-max values down to 60000 ms', () => {
    expect(MAX_REPLY_LEAVE_GRACE_MS).toBe(60000);
    expect(clampReplyLeaveGraceMs(60001)).toBe(MAX_REPLY_LEAVE_GRACE_MS);
    expect(clampReplyLeaveGraceMs(999999)).toBe(MAX_REPLY_LEAVE_GRACE_MS);
  });

  it('rounds fractional values to integer ms', () => {
    expect(clampReplyLeaveGraceMs(1999.6)).toBe(2000);
    expect(clampReplyLeaveGraceMs(250.4)).toBe(250);
    expect(clampReplyLeaveGraceMs(250.6)).toBe(251);
  });

  it('passes in-range integers through unchanged', () => {
    expect(clampReplyLeaveGraceMs(0)).toBe(0);
    expect(clampReplyLeaveGraceMs(1250)).toBe(1250);
    expect(clampReplyLeaveGraceMs(60000)).toBe(60000);
  });
});

describe('CompanionProvider — #2892 ST-1 persisted settings load', () => {
  it('defaults to queue + 2000 ms on a fresh profile', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    expect(presence().sendDuringReply).toBe('queue');
    expect(presence().replyLeaveGraceMs).toBe(2000);
  });

  it('loads a stored interrupt disposition and a stored grace through the SAME path', async () => {
    await mountProvider({
      visible: true,
      timeoutS: 5,
      seedSendDuringReply: 'interrupt',
      seedGraceMs: '1500',
    });
    expect(presence().sendDuringReply).toBe('interrupt');
    expect(presence().replyLeaveGraceMs).toBe(1500);
  });

  it('heals an unknown/stale stored disposition to the queue default', async () => {
    await mountProvider({ visible: true, timeoutS: 5, seedSendDuringReply: 'supersede' });
    expect(presence().sendDuringReply).toBe('queue');
  });

  it('heals a cleared/non-numeric stored grace to the 2000 ms default', async () => {
    await mountProvider({ visible: true, timeoutS: 5, seedGraceMs: 'abc' });
    expect(presence().replyLeaveGraceMs).toBe(2000);
  });

  it('clamps an out-of-range stored grace (negative → 0, above max → 60000)', async () => {
    await mountProvider({ visible: true, timeoutS: 5, seedGraceMs: '-5' });
    expect(presence().replyLeaveGraceMs).toBe(0);

    cleanup();
    await mountProvider({ visible: true, timeoutS: 5, seedGraceMs: '999999' });
    expect(presence().replyLeaveGraceMs).toBe(60000);
  });
});

describe('CompanionProvider — #2892 ST-1 setting setters persist + clamp', () => {
  it('setSendDuringReply writes the exact key and updates the context value', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    act(() => { api.setSendDuringReply('interrupt'); });
    expect(presence().sendDuringReply).toBe('interrupt');
    expect(setSpy).toHaveBeenCalledWith(COMPANION_SEND_DURING_REPLY_KEY, 'interrupt');

    act(() => { api.setSendDuringReply('queue'); });
    expect(presence().sendDuringReply).toBe('queue');
    expect(setSpy).toHaveBeenCalledWith(COMPANION_SEND_DURING_REPLY_KEY, 'queue');
    setSpy.mockRestore();
  });

  it('setReplyLeaveGraceMs persists a clamped integer ms value', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    act(() => { api.setReplyLeaveGraceMs(1500); });
    expect(presence().replyLeaveGraceMs).toBe(1500);
    expect(setSpy).toHaveBeenCalledWith(REPLY_LEAVE_GRACE_SETTING_KEY, '1500');

    act(() => { api.setReplyLeaveGraceMs(-5); });
    expect(presence().replyLeaveGraceMs).toBe(0);

    act(() => { api.setReplyLeaveGraceMs(999999); });
    expect(presence().replyLeaveGraceMs).toBe(60000);

    act(() => { api.setReplyLeaveGraceMs(1250.6); });
    expect(presence().replyLeaveGraceMs).toBe(1251);
    setSpy.mockRestore();
  });
});

describe('CompanionProvider — #2892 ST-1 transient signals', () => {
  it('replyInFlight flips via setReplyInFlight and is NEVER persisted', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    expect(presence().replyInFlight).toBe(false);
    act(() => { api.setReplyInFlight(true); });
    expect(presence().replyInFlight).toBe(true);
    act(() => { api.setReplyInFlight(false); });
    expect(presence().replyInFlight).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('queuedSendCount flips via setQueuedSendCount and is NEVER persisted', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    const setSpy = vi.spyOn(settingsService, 'set');

    expect(presence().queuedSendCount).toBe(0);
    act(() => { api.setQueuedSendCount(3); });
    expect(presence().queuedSendCount).toBe(3);
    act(() => { api.setQueuedSendCount(0); });
    expect(presence().queuedSendCount).toBe(0);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('the transient signals never touch the presence reducer (#2853 invariants preserved)', async () => {
    await mountProvider({ visible: true, timeoutS: 5 });
    act(() => { api.setReplyInFlight(true); });
    act(() => { api.setQueuedSendCount(2); });

    expect(presence().visible).toBe(true, 'visibility untouched');
    expect(presence().inUse).toBe(false, 'isInUse untouched');
    expect(presence().away).toBe(false, 'location untouched');
    expect(presence().autoHidden).toBe(false);
  });
});
