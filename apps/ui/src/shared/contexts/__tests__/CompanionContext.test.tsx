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
} from '@/shared/contexts/CompanionContext';
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
  const { isVisible, isAutoHidden, isAutoReturning, isHosting, isInUse } = api.state;
  return (
    <div
      data-testid="presence"
      data-visible={String(isVisible)}
      data-autohidden={String(isAutoHidden)}
      data-autoreturning={String(isAutoReturning)}
      data-hosting={String(isHosting)}
      data-inuse={String(isInUse)}
      data-present={String(isVisible && !isAutoHidden)}
      data-idle-timeout={String(api.idleTimeoutSeconds)}
    />
  );
}

function presence() {
  const el = screen.getByTestId('presence');
  return {
    visible: el.getAttribute('data-visible') === 'true',
    autoHidden: el.getAttribute('data-autohidden') === 'true',
    autoReturning: el.getAttribute('data-autoreturning') === 'true',
    hosting: el.getAttribute('data-hosting') === 'true',
    inUse: el.getAttribute('data-inuse') === 'true',
    present: el.getAttribute('data-present') === 'true',
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
 */
async function mountProvider({ visible, timeoutS = 5 }: { visible: boolean; timeoutS?: number }) {
  localStorage.clear();
  localStorage.setItem(IDLE_TIMEOUT_SETTING_KEY, String(timeoutS));
  if (visible) localStorage.setItem('Fredo_companion_visible', 'true');

  const view = renderWithChakra(
    <CompanionProvider>
      <PresenceProbe />
    </CompanionProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId('presence').getAttribute('data-visible')).toBe(String(visible));
    expect(screen.getByTestId('presence').getAttribute('data-idle-timeout')).toBe(String(timeoutS));
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
