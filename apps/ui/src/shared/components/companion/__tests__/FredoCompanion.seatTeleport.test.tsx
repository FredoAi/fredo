/**
 * #2870 ST-2c — seat→away teleport dispatch integration test.
 *
 * The prior wiring gap: `FredoCompanion`'s window-level Ctrl+right-click handler
 * dispatched through a ref attached ONLY to the away OVERLAY `CompanionEntity`.
 * At home the overlay is not rendered (ST-2b gates it on `isAway`), so the ref
 * was null and the gesture was a silent no-op — the home SEAT (rendered by
 * `LauncherShell` in a different React subtree) was unreachable.
 *
 * These tests render the REAL `FredoCompanion` (host: the single window-level
 * mousedown + companion-teleport listeners) together with a faithful seat-slot
 * harness (mirrors LauncherShell's seat predicate: interactive seat while ON and
 * home, nothing while away) under jsdom, with `__TAURI_INTERNALS__` absent so the
 * dev branch runs (`IS_TAURI === false`). They prove:
 *   1. Ctrl+right-click at the home seat reaches the SEAT entity, plays the
 *      preserved out(400+50) → in(400+50) sequence, and leaves the seat as the
 *      away OVERLAY at the clamped teleport coordinates — never two avatars;
 *   2. after the swap, a further gesture reaches the OVERLAY (the registry
 *      switched to the active surface);
 *   3. when NO entity is mounted in the window (Fredo home in main, gesture fired
 *      in the terminal window), the host still dispatches the request itself so
 *      the cross-window hand-off starts (clamp uses the exact `AVATAR_SM` box).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion } from '@/shared/contexts/CompanionContext';
import { CompanionEntity, FredoCompanion } from '@/shared/components/companion';
import { DevAdapter } from '@/app/adapters/DevAdapter';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { AVATAR_SM } from '@/shared/components/fredo-avatar/fredoAvatarSizes';

// The framer-motion mock needs React.createElement at render time; it is obtained
// from the test file's React import (evaluated before any test renders).
motionMock.setReact(React);

// ── Module mocks ────────────────────────────────────────────────────────────────
const tauriEvent = vi.hoisted(() => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: tauriEvent.emit, listen: tauriEvent.listen }));

const motionMock = vi.hoisted(() => {
  let react: { createElement: (tag: string, props: unknown, ...children: unknown[]) => unknown } | null = null;
  const cache = new Map<string, (props: Record<string, unknown>) => unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        let comp = cache.get(tag);
        if (!comp) {
          comp = (props: Record<string, unknown>) => {
            if (!react) throw new Error('framer-motion mock: React not set yet');
            const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...rest } = props ?? {};
            const children = (props as { children?: unknown }).children;
            if (children !== undefined) return react.createElement(tag, { ...rest }, children);
            return react.createElement(tag, { ...rest });
          };
          cache.set(tag, comp);
        }
        return comp;
      },
    },
  );
  return {
    setReact(r: typeof react) { react = r; },
    motion,
    AnimatePresence: ({ children }: { children?: unknown }) => children ?? null,
  };
});

vi.mock('framer-motion', () => ({
  AnimatePresence: motionMock.AnimatePresence,
  motion: motionMock.motion,
  useReducedMotion: () => false,
}));

// ── Environment pins (jsdom has no layout / is 1024×768 by default) ─────────────
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => AVATAR_SM.width,
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => AVATAR_SM.height,
});
Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 768 });

/** Mirrors LauncherShell's seat predicate (#2870 ST-3): the interactive seat is
 *  rendered only while the companion is ON and Fredo is home; away => empty seat. */
function SeatSlot() {
  const { state } = useCompanion();
  if (!state.isVisible || state.isAway) return null;
  return <CompanionEntity surface="seat" />;
}

/** Renders a probe attribute so tests can await the async persisted-visible load. */
function VisibilityProbe() {
  const { state } = useCompanion();
  return <div data-testid="visible-probe" data-visible={String(state.isVisible)} />;
}

const avatars = (c: HTMLElement) => c.querySelectorAll<HTMLElement>('.fredo-companion-avatar');
const avatar = (c: HTMLElement): HTMLElement => {
  const el = c.querySelector<HTMLElement>('.fredo-companion-avatar');
  expect(el).not.toBeNull();
  return el as HTMLElement;
};

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  tauriEvent.emit.mockClear();
  tauriEvent.listen.mockClear();
  localStorage.clear();

  const devAdapter = new DevAdapter();
  adapterBridge.setInvoke(devAdapter.invoke.bind(devAdapter));
  adapterBridge.setLlmChat(devAdapter.llmChat.bind(devAdapter));
  adapterBridge.setLlmChatWithImage(devAdapter.llmChatWithImage.bind(devAdapter));
  adapterBridge.setListen(() => Promise.resolve(() => {}));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('FredoCompanion seat→away teleport dispatch (#2870 ST-2c)', () => {
  it('Ctrl+right-click at the home seat reaches the SEAT and leaves the away overlay at the clamped point', async () => {
    localStorage.setItem('Fredo_companion_visible', 'true');
    const { container } = renderWithChakra(
      <CompanionProvider>
        <SeatSlot />
        <FredoCompanion />
      </CompanionProvider>,
    );
    // At home the single rendered avatar is the SEAT (in-flow, position:relative);
    // the away overlay is NOT mounted while Fredo is home.
    await waitFor(() => expect(avatars(container)).toHaveLength(1));
    const seat = avatar(container);
    expect(seat.style.position).toBe('relative');
    expect(seat.getAttribute('data-state')).toBe('idle');

    vi.useFakeTimers();
    act(() => {
      // Ctrl+right-click at (500,400) — window-level handler (FredoCompanion),
      // dispatched to the ACTIVE entity registered by the seat.
      window.dispatchEvent(
        new MouseEvent('mousedown', { button: 2, ctrlKey: true, clientX: 500, clientY: 400 }),
      );
    });
    // The request reached the SEAT: its leave motion is playing (previously a
    // silent no-op — the seat was unreachable).
    expect(avatar(container).getAttribute('data-state')).toBe('teleport-out');

    // out (400+50) → the seat hands off on the context teleport: Fredo is away,
    // the seat is replaced by the away OVERLAY at the clamped point.
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(avatars(container)).toHaveLength(1);
    const overlay = avatar(container);
    expect(overlay.style.position).toBe('fixed');
    // x = clamp(500 − 40, 0, 1024 − 80) = 460; y = clamp(400 − 50, 0, 768 − 100) = 350.
    expect(overlay.style.left).toBe('460px');
    expect(overlay.style.top).toBe('350px');

    // The registry switched to the OVERLAY: a further gesture moves it.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousedown', { button: 2, ctrlKey: true, clientX: 200, clientY: 200 }),
      );
    });
    expect(avatar(container).getAttribute('data-state')).toBe('teleport-out');
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(avatar(container).getAttribute('data-state')).toBe('teleport-in');
    // x = clamp(200 − 40, 0, 1024 − 80) = 160; y = clamp(200 − 50, 0, 768 − 100) = 150.
    expect(avatar(container).style.left).toBe('160px');
    expect(avatar(container).style.top).toBe('150px');
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(avatar(container).getAttribute('data-state')).toBe('idle');
    expect(avatars(container)).toHaveLength(1);

    // Dev branch: no Tauri broadcast was attempted, console clean.
    expect(tauriEvent.emit).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('dispatches the request itself when NO entity is mounted in this window (cross-window start)', async () => {
    localStorage.setItem('Fredo_companion_visible', 'true');
    // No SeatSlot here: this models a window that is not displaying Fredo (Fredo
    // sits at the main-window seat) — the host must still dispatch the request so
    // the cross-window hand-off starts instead of no-op'ing.
    const { container, getByTestId } = renderWithChakra(
      <CompanionProvider>
        <VisibilityProbe />
        <FredoCompanion />
      </CompanionProvider>,
    );
    await waitFor(() => expect(getByTestId('visible-probe').getAttribute('data-visible')).toBe('true'));
    expect(avatars(container)).toHaveLength(0);

    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousedown', { button: 2, ctrlKey: true, clientX: 500, clientY: 400 }),
      );
    });
    // Dev branch fallback settles the context directly at the clamped point.
    expect(avatars(container)).toHaveLength(1);
    const overlay = avatar(container);
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.left).toBe('460px');
    expect(overlay.style.top).toBe('350px');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not start a teleport on a right-click without Ctrl', async () => {
    localStorage.setItem('Fredo_companion_visible', 'true');
    const { container } = renderWithChakra(
      <CompanionProvider>
        <SeatSlot />
        <FredoCompanion />
      </CompanionProvider>,
    );
    await waitFor(() => expect(avatars(container)).toHaveLength(1));
    act(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 2, clientX: 500, clientY: 400 }));
    });
    expect(avatar(container).getAttribute('data-state')).toBe('idle');
    expect(avatar(container).style.position).toBe('relative');
  });
});
