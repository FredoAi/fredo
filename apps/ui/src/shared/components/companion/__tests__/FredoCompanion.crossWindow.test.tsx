/**
 * #2870 ST-2c — Tauri cross-window `companion-teleport` listener coverage.
 *
 * The dev-branch seat test (`FredoCompanion.seatTeleport.test.tsx`) covers the
 * in-window dispatch with `IS_TAURI === false`. This file forces the Tauri branch
 * (`__TAURI_INTERNALS__` present at module load via `vi.hoisted`) and captures
 * the host's single `companion-teleport` listener so the cross-window branches can
 * be driven deterministically in jsdom:
 *   - same-window (`toWindow === MY_WINDOW`) → the ACTIVE entity (the home seat)
 *     plays the preserved out→in and Fredo ends up away over the seat;
 *   - leaving (`toWindow !== MY_WINDOW`) → the home seat drops immediately and
 *     this window settles hosting (no stuck `isAway && isInThisWindow`);
 *   - arrival (`toWindow === MY_WINDOW`, not yet hosting) → the away overlay
 *     mounts at the destination and plays the in motion.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider, useCompanion } from '@/shared/contexts/CompanionContext';
import { CompanionEntity, FredoCompanion } from '@/shared/components/companion';
import { DevAdapter } from '@/app/adapters/DevAdapter';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { AVATAR_SM } from '@/shared/components/fredo-avatar/fredoAvatarSizes';

// Force the Tauri branch BEFORE the companion modules are evaluated — with a
// FUNCTIONAL internals stub, the same contract `CompanionContext.test.tsx:55-72`
// carries. The companion plumbing fires-and-forgets its `@tauri-apps/api` dynamic
// imports (`CompanionContext.tsx:360-365` emitPresence, `:418-431` the presence
// listener; `FredoCompanion.tsx:61/:149` and `CompanionEntity.tsx:478` likewise),
// so a continuation can outlive this file's `vi.mock('@tauri-apps/api/event')`
// registry and the file teardown and then resolve to the REAL module. An EMPTY `{}`
// stub turns that escaped call into an unhandled rejection —
// `TypeError: window.__TAURI_INTERNALS__.invoke is not a function`
// (core.js:202 invoke ← event.js:129 emit ← `CompanionContext.tsx:363`, exactly the
// `ui-validate` CI annotation) — which vitest reports for this file and exits 1
// although every test passed. A functional stub makes any escaped real call (emit,
// listen, its unmount unlisten) resolve harmlessly instead of rejecting.
vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
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
  // The real `listen()`'s returned unlisten touches this plugin-internals global on
  // teardown — present it so an escaped real `listen` cannot reject on unmount.
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
});

type TeleportPayload = { toWindow: string; x: number; y: number };
type Listener = (ev: { payload: TeleportPayload }) => void;

const tauri = vi.hoisted(() => {
  const listeners = new Map<string, Set<(ev: { payload: unknown }) => void>>();
  return {
    listeners,
    listen: vi.fn((event: string, cb: (ev: { payload: unknown }) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return Promise.resolve(() => { listeners.get(event)!.delete(cb); });
    }),
    emit: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen, emit: tauri.emit }));

motionMock.setReact(React);
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

/** Mirrors LauncherShell's seat predicate: interactive seat while ON and home. */
function SeatSlot() {
  const { state } = useCompanion();
  if (!state.isVisible || state.isAway) return null;
  return <CompanionEntity surface="seat" />;
}

function HostingProbe() {
  const { state } = useCompanion();
  return <div data-testid="hosting-probe" data-hosting={String(state.isHosting)} data-away={String(state.isAway)} />;
}

type CompanionApi = ReturnType<typeof useCompanion>;
let api: CompanionApi;

/** Captures the live context API so a test can drive lifecycle transitions directly. */
function ApiProbe() {
  api = useCompanion();
  return null;
}

const avatar = (c: HTMLElement): HTMLElement => {
  const el = c.querySelector<HTMLElement>('.fredo-companion-avatar');
  expect(el).not.toBeNull();
  return el as HTMLElement;
};

/** Waits until the host has registered its `companion-teleport` listener. */
async function teleportListener(): Promise<Listener> {
  await waitFor(() => expect(tauri.listen.mock.calls.some(([e]) => e === 'companion-teleport')).toBe(true));
  const set = tauri.listeners.get('companion-teleport');
  expect(set && set.size).toBeGreaterThan(0);
  return [...(set as Set<Listener>)][0];
}

async function renderCompanion() {
  localStorage.setItem('Fredo_companion_visible', 'true');
  const view = renderWithChakra(
    <CompanionProvider>
      <SeatSlot />
      <HostingProbe />
      <FredoCompanion />
      <ApiProbe />
    </CompanionProvider>,
  );
  await waitFor(() => expect(view.container.querySelectorAll('.fredo-companion-avatar')).toHaveLength(1));
  return view;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tauri.listen.mockClear();
  tauri.emit.mockClear();
  tauri.listeners.clear();
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

describe('FredoCompanion cross-window companion-teleport listener (#2870 ST-2c)', () => {
  it('Tauri Ctrl+right-click at the home seat emits companion-teleport {toWindow: main} with the clamped point', async () => {
    await renderCompanion();
    await teleportListener();

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mousedown', { button: 2, ctrlKey: true, clientX: 500, clientY: 400 }),
      );
    });

    await waitFor(() =>
      expect(tauri.emit).toHaveBeenCalledWith('companion-teleport', { toWindow: 'main', x: 460, y: 350 }),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('same-window listener teleport drives the SEAT away (out → overlay at the point)', async () => {
    const { container } = await renderCompanion();
    const cb = await teleportListener();

    vi.useFakeTimers();
    act(() => {
      // The wire payload already carries the CLAMPED destination (the request
      // clamps before emitting) — (500,400) → (460,350) for the 80×100 box.
      cb({ payload: { toWindow: 'main', x: 460, y: 350 } });
    });
    expect(avatar(container).getAttribute('data-state')).toBe('teleport-out');

    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(container.querySelectorAll('.fredo-companion-avatar')).toHaveLength(1);
    const overlay = avatar(container);
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.left).toBe('460px');
    expect(overlay.style.top).toBe('350px');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('leaving drops the home seat and settles hosting; arrival mounts the overlay and plays in', async () => {
    const { container, getByTestId } = await renderCompanion();
    const cb = await teleportListener();

    vi.useFakeTimers();
    // Source leg: this window is told Fredo moved to another window.
    act(() => {
      cb({ payload: { toWindow: 'terminal', x: 460, y: 350 } });
    });
    expect(container.querySelectorAll('.fredo-companion-avatar')).toHaveLength(0);
    expect(getByTestId('hosting-probe').getAttribute('data-away')).toBe('true');
    // The seat leave must settle hosting synchronously (no stuck isAway && hosting).
    expect(getByTestId('hosting-probe').getAttribute('data-hosting')).toBe('false');

    // Destination leg: a teleport back to this window arrives.
    act(() => {
      cb({ payload: { toWindow: 'main', x: 260, y: 150 } });
    });
    const overlay = avatar(container);
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.left).toBe('260px');
    expect(overlay.style.top).toBe('150px');
    // The in motion plays (child handle registered before the host's arrive effect).
    expect(overlay.getAttribute('data-state')).toBe('teleport-in');

    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(avatar(container).getAttribute('data-state')).toBe('idle');
    expect(getByTestId('hosting-probe').getAttribute('data-hosting')).toBe('true');
    expect(consoleError).not.toHaveBeenCalled();
  });

  // #2870 F-68: an idle auto-return followed by a teleport must leave exactly ONE
  // Fredo (the away overlay). A stale `isAutoHidden` previously gated the overlay
  // off while the seat was already gone — zero Fredos until an OFF/ON toggle.
  it('auto-return settle → teleport leaves exactly ONE Fredo (the overlay) (F-68)', async () => {
    const { container } = await renderCompanion();

    // Settle an idle auto-return: Fredo returns home (the seat) while auto-hidden.
    act(() => { api.confirmAutoReturn(); });
    expect(container.querySelectorAll('.fredo-companion-avatar')).toHaveLength(1);

    // The next relocation must clear that stale hide state and mount the overlay.
    act(() => { api.teleport(320, 240); });

    const avatars = container.querySelectorAll('.fredo-companion-avatar');
    expect(avatars).toHaveLength(1);
    expect(avatars[0].style.position).toBe('fixed');
    expect(avatars[0].style.left).toBe('320px');
    expect(avatars[0].style.top).toBe('240px');
    expect(consoleError).not.toHaveBeenCalled();
  });

  // G-156 / #2883 — HONEST REGRESSION PIN for the harness contract above. The CI
  // `ui-validate` annotation was an unhandled rejection from the REAL
  // `@tauri-apps/api` `emit` escaping this file's `vi.mock`; `vi.importActual`
  // deliberately bypasses the mock to exercise that exact escaped-real-module path.
  // With an EMPTY internals stub this test fails with the annotation's
  // `TypeError: window.__TAURI_INTERNALS__.invoke is not a function`; with the
  // functional stub the escaped real emit/listen (and its unlisten) must resolve.
  it('harness contract — an escaped REAL @tauri-apps/api emit/listen resolves without rejecting (CI unhandled-rejection guard)', async () => {
    const realEvent = await vi.importActual<typeof import('@tauri-apps/api/event')>('@tauri-apps/api/event');

    await expect(realEvent.emit('companion-presence', { from: 'main', reason: 'show' })).resolves.toBeUndefined();

    const unlisten = await realEvent.listen('companion-presence', () => {});
    await expect(unlisten()).resolves.toBeUndefined();
  });
});
