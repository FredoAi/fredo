/**
 * R2-1 — Dev-branch jsdom integration test for FredoCompanion (Q-18 / M10 evidence).
 *
 * Issue #2850 round 2 (Fix Plan R2-1). Round-1's tester verdict FAILed AC-4 solely
 * because QA row Q-18 (M10 dev-mode leg — standalone Vite/DevAdapter page driven in a
 * NON-Tauri browser) could not be exercised in-environment: the tester sandbox exposes
 * only Tauri webview tools bound to the running desktop app. The dev branch itself is
 * code-correct per static verification (FredoCompanion.tsx:50/:154/:200-208).
 *
 * This file renders the REAL `FredoCompanion` (no mock of it) under jsdom with the
 * DevAdapter implementations registered on `adapterBridge` and `__TAURI_INTERNALS__`
 * absent (guarantees `IS_TAURI === false` at FredoCompanion.tsx:50), wrapped in
 * `CompanionProvider` + the shared `renderWithChakra`, with the viewport and the
 * avatar's rendered box pinned. It deterministically covers the dev-mode observables
 * Q-18 required:
 *   1. dev render — sm avatar idle + the frozen 58-rect geometry + viewBox, driven by
 *      the persisted `Fredo_companion_visible` key;
 *   2. mock joke stream — single click streams a DevAdapter mock joke token-by-token
 *      (30 ms cadence) into the bubble with the 2×14 px blinking cursor, then talk
 *      holds and returns to idle + bubble closes;
 *   3. Ctrl+right-click teleports LOCALLY with ZERO `companion-teleport` emit and no
 *      attempt at the guarded `import('@tauri-apps/api/event')`;
 *   4. double-click opens TicTacToe and Fredo (O) replies in a LEGAL EMPTY cell via the
 *      `capture_screen_region` no-op fallback (TicTacToe.tsx:46-53 → catch :93-100),
 *      plus the stubbed-capture seam proving the DevAdapter.llmChatWithImage `'4'`
 *      center answer (PO-amended Q-18 expectation).
 *
 * Visibility is flipped via the persisted-key path (CompanionContext.tsx:70-79 +
 * usePersistedSetting.ts:28-37): seed `Fredo_companion_visible = 'true'` and await the
 * async settingsService/localStorage load — the FIRST option the Fix Plan lists. (A
 * consumer-effect harness was tried and REJECTED: the context value object is recreated
 * every render, so `setVisible` is a fresh reference each render and an effect depending
 * on it re-runs forever — an infinite re-render loop.)
 *
 * Regression invariants (carry-over): the 58 base rects stay byte-identical to the
 * frozen `FREDO_AVATAR_SOURCE_RECTS` expansion; the 250 ms single/double discriminator
 * is exercised; teleport timing (400+50 out / 400+50 in) and the 5 s talk hold are
 * asserted observably; the Tauri branch (IS_TAURI === true) is NOT exercised here
 * (proven live by Q-9..Q-12). No static `@tauri-apps/api` import is introduced.
 *
 * Product code is UNTOUCHED — this is an evidence-only test file (git diff = 1 file).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider } from '@/shared/contexts/CompanionContext';
import { FredoCompanion } from '@/shared/components/companion';
import { DevAdapter } from '@/app/adapters/DevAdapter';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { AVATAR_SM } from '@/shared/components/fredo-avatar/fredoAvatarSizes';
import {
  expandFredoRects,
  FREDO_AVATAR_SOURCE_RECTS,
} from '@/shared/components/fredo-avatar/fredoAvatarGeometry';

// The framer-motion mock needs React.createElement at render time; it is obtained from
// the test file's React import (evaluated before any test renders).
motionMock.setReact(React);

// ── Module mocks ────────────────────────────────────────────────────────────────
//
// `@tauri-apps/api/event` — never statically imported anywhere in the graph. The
// factory records whether the dynamic import in FredoCompanion.tsx:157/:202 was EVER
// attempted; with IS_TAURI false it must stay untouched (proving "no broadcast attempt
// / no crash on the dynamic import path").
const tauriEvent = vi.hoisted(() => ({
  imported: false,
  emit: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => {
  tauriEvent.imported = true;
  return { emit: tauriEvent.emit, listen: tauriEvent.listen };
});

// framer-motion — neutralized for jsdom (established precedent: AppDock mocks
// `useReducedMotion`). AnimatePresence becomes a passthrough so bubble open/close is
// deterministic in jsdom, and `motion.div` renders a plain div with the framer-specific
// props stripped (the spring itself is product code, untouched). The REAL framer-motion
// module also deadlocks the mount inside `act` when fake timers are active before the
// render — this mock keeps the render deterministic.
const motionMock = vi.hoisted(() => {
  let react: { createElement: (tag: string, props: unknown, ...children: unknown[]) => unknown } | null = null;
  // Cache one component per tag so `motion.div` has a STABLE identity across renders —
  // a fresh function per render would make React unmount/remount the whole bubble on
  // every re-render (losing streaming tokens and the TicTacToe board state).
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
    setReact(r: typeof react) {
      react = r;
    },
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
//
// jsdom reports offsetWidth/offsetHeight = 0 for every element, but the companion's
// teleport clamp + bubble anchor read the avatar's REAL rendered box via the wrapper
// (FredoCompanion.tsx:79-85). Pin the sm box (80×100 — AVATAR_SM) so getAvatarSize()
// reports the same dimensions the live DOM reports. The viewport is pinned to the
// jsdom default so the clamp math is deterministic and explicit.
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

// ── Render helpers ───────────────────────────────────────────────────────────────
//
// Visibility starts false. Flip it through the REAL persisted-key path: seed
// `Fredo_companion_visible = 'true'` and wait for the async settingsService/localStorage
// load (CompanionContext.tsx:70-79 + usePersistedSetting.ts:28-37) to dispatch
// SET_VISIBLE(true). Fake timers are installed AFTER the mount so the mount effects
// (the async load) complete on real timers.
async function renderVisibleCompanion() {
  localStorage.setItem('Fredo_companion_visible', 'true');
  const view = renderWithChakra(
    <CompanionProvider>
      <FredoCompanion />
    </CompanionProvider>,
  );
  await waitFor(() => {
    expect(view.container.querySelector('.fredo-companion-avatar')).not.toBeNull();
  });
  return view;
}

function avatar(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.fredo-companion-avatar');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

/** The 9 TicTacToe cells — the only 56×56 divs in the game bubble. */
function boardCells(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('div')).filter((el) => {
    const cs = getComputedStyle(el);
    return cs.width === '56px' && cs.height === '56px';
  });
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Dev branch guarantee: NO Tauri host in this jsdom.
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  tauriEvent.imported = false;
  tauriEvent.emit.mockClear();
  tauriEvent.listen.mockClear();
  localStorage.clear();

  // Register the DevAdapter implementations the standalone Vite page registers
  // (main.tsx:23-25) — the adapterBridge is the real singleton the component uses.
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

describe('FredoCompanion dev branch (Q-18/M10 jsdom evidence)', () => {
  it('renders the sm avatar idle with the frozen 58-rect geometry and reads the persisted visible key', async () => {
    // isVisible defaults false — the persisted `Fredo_companion_visible` key
    // (CompanionContext.tsx:70-79 + usePersistedSetting.ts:28-37) flips visibility
    // after the async settingsService/localStorage load.
    localStorage.setItem('Fredo_companion_visible', 'true');
    const { container } = renderWithChakra(
      <CompanionProvider>
        <FredoCompanion />
      </CompanionProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('.fredo-companion-avatar')).not.toBeNull();
    });

    const el = avatar(container);
    expect(el.getAttribute('data-state')).toBe('idle');
    expect(el.getAttribute('aria-label')).toBe('Fredo companion -- idle');

    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 1014 1264');

    // Frozen-geometry invariant: 58 base rects, byte-identical to the
    // FREDO_AVATAR_SOURCE_RECTS expansion (27 mirrored pairs + 4 center singles).
    const rects = svg!.querySelectorAll('rect');
    expect(rects).toHaveLength(58);
    const expected = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
    rects.forEach((r, i) => {
      expect(Number(r.getAttribute('x'))).toBe(expected[i].x);
      expect(Number(r.getAttribute('y'))).toBe(expected[i].y);
      expect(Number(r.getAttribute('width'))).toBe(expected[i].width);
      expect(Number(r.getAttribute('height'))).toBe(expected[i].height);
    });

    // No overlay in idle and no errors on the persisted-read boot.
    expect(el.querySelector('#fredo-expression')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('streams a DevAdapter mock joke token-by-token on single click and returns to idle', async () => {
    // Deterministic DevAdapter mock — mock[0] is picked for Math.random() === 0.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = await renderVisibleCompanion();

    // Mount completes on real timers; switch to fake timers for the interaction.
    vi.useFakeTimers();
    act(() => {
      fireEvent.pointerDown(avatar(container));
      fireEvent.click(avatar(container));
    });
    // Single/double discriminator (250 ms): nothing fires yet.
    expect(avatar(container).getAttribute('data-state')).toBe('idle');

    // After the 250 ms discriminator the joke starts: #2854 R-2a/Q2 — the LLM
    // wait renders `thinking` (NOT `talk`, which #2850 asserted) + streaming marks.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(avatar(container).getAttribute('data-state')).toBe('thinking');
    expect(avatar(container).getAttribute('data-streaming')).toBe('true');

    // Placeholder shows while waiting for the first DevAdapter token; the 2×14 px
    // Fredo-cursor-blink cursor renders while streaming.
    const textEl = screen.getByText('💭 Thinking...');
    const cursor = textEl.querySelector('span');
    expect(cursor).not.toBeNull();
    const cs = getComputedStyle(cursor as HTMLElement);
    expect(cs.width).toBe('2px');
    expect(cs.height).toBe('14px');
    expect(cs.animation).toContain('Fredo-cursor-blink');

    // Token-by-token fill at the DevAdapter 30 ms cadence.
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(textEl.textContent).toHaveLength(1);
    const firstToken = textEl.textContent;
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(textEl.textContent).toHaveLength(2);
    expect(textEl.textContent?.startsWith(firstToken ?? '')).toBe(true);

    // Drain the 30 ms interval until DevAdapter calls onDone (streaming mark drops).
    for (let i = 0; i < 400; i += 1) {
      act(() => {
        vi.advanceTimersByTime(30);
      });
      if (avatar(container).getAttribute('data-streaming') == null) break;
    }
    expect(avatar(container).getAttribute('data-streaming')).toBeNull();
    // #2854 R-3a/Q3 — happy holds after onDone (the 5 s HAPPY_HOLD_MS timer has
    // not fired yet); full joke text is in the bubble and the placeholder +
    // streaming cursor are gone.
    expect(avatar(container).getAttribute('data-state')).toBe('happy');
    expect((textEl.textContent ?? '').length).toBeGreaterThan(20);
    expect(screen.queryByText('💭 Thinking...')).toBeNull();
    expect(textEl.querySelector('span')).toBeNull();

    // After the 5 s hold: idle + bubble closes.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(avatar(container).getAttribute('data-state')).toBe('idle');
    expect(screen.queryByText(/Why do programmers prefer dark mode/)).toBeNull();
    // Console-clean: no Error:/Uncaught across the stream.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('teleports locally on Ctrl+right-click with zero companion-teleport emit (guarded import never fires)', async () => {
    const { container } = await renderVisibleCompanion();

    const start = avatar(container);
    expect(start.getAttribute('data-state')).toBe('idle');
    // Initial placement from the context default (1024 − 120, 768 − 160).
    expect(start.style.left).toBe('904px');
    expect(start.style.top).toBe('608px');

    // Ctrl+right-click at (500,400) — handleMouseDown (FredoCompanion.tsx:200-208)
    // takes the ELSE (dev) branch: local startTeleportOut, no emit.
    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousedown', { button: 2, ctrlKey: true, clientX: 500, clientY: 400 }),
      );
    });
    expect(avatar(container).getAttribute('data-state')).toBe('teleport-out');
    // Position is unchanged during teleport-out.
    expect(avatar(container).style.left).toBe('904px');
    expect(avatar(container).style.top).toBe('608px');

    // Out (400 + 50) → teleport-in at the clamped point (sm 80×100 box):
    // x = clamp(500 − 40, 0, 1024 − 80) = 460; y = clamp(400 − 50, 0, 768 − 100) = 350.
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(avatar(container).getAttribute('data-state')).toBe('teleport-in');
    expect(avatar(container).style.left).toBe('460px');
    expect(avatar(container).style.top).toBe('350px');

    // In (400 + 50) → idle.
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(avatar(container).getAttribute('data-state')).toBe('idle');

    // No Tauri broadcast: the guarded import('@tauri-apps/api/event') was never
    // attempted (module factory never ran) and emit was never called.
    expect(tauriEvent.imported).toBe(false);
    expect(tauriEvent.emit).not.toHaveBeenCalled();
    // Console-clean across the teleport sequence.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('opens TicTacToe on double-click and Fredo answers in a legal empty cell via the dev capture no-op', async () => {
    const { container } = await renderVisibleCompanion();

    vi.useFakeTimers();
    act(() => {
      fireEvent.click(avatar(container));
      fireEvent.click(avatar(container));
    });
    // No joke on double-click (the 250 ms discriminator is consumed) — game bubble opens.
    expect(avatar(container).getAttribute('data-state')).toBe('idle');
    expect(avatar(container).getAttribute('data-streaming')).toBeNull();

    expect(screen.getByText('Your turn (X)')).toBeInTheDocument();
    const gameBubble = screen
      .getByText('Your turn (X)')
      .closest('[style*="z-index: 101"]') as HTMLElement;
    expect(gameBubble).not.toBeNull();
    expect(getComputedStyle(gameBubble).width).toBe('208px');
    expect(getComputedStyle(gameBubble).height).toBe('268px');

    const cells = boardCells(container);
    expect(cells).toHaveLength(9);

    // X at cell 8. In dev, adapterBridge.invoke('capture_screen_region') no-ops
    // (DevAdapter.ts:35-38 → undefined) → TicTacToe.tsx:53 throws → the legal-move
    // catch (TicTacToe.tsx:93-100) plays the first-empty fallback. Because the
    // fallback reads the pre-X board closure, the first empty index is 0 — a LEGAL
    // empty cell (X sits at 8).
    act(() => {
      fireEvent.click(cells[8]);
    });
    // Advance the 200 ms trigger timer AND flush the async invoke chain
    // (DevAdapter.invoke → undefined → throw → legal-move catch).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(cells[8].textContent?.trim()).toBe('X');
    expect(cells[0].textContent?.trim()).toBe('O');
    // The dev path's expected error-path log is not an uncaught/unhandled error.
    const errCalls = consoleError.mock.calls.map((c) => String(c[0]));
    expect(errCalls.some((m) => /Uncaught|Unhandled/.test(m))).toBe(false);
  });

  it('returns the DevAdapter llmChatWithImage center "4" when capture_screen_region is stubbed (mock-answer seam)', async () => {
    // Stubbed capture gate — the seam the PO-amended Q-18 row covers: when the
    // capture invoke DOES return a non-empty base64, the dev mock answer '4' (the
    // center cell) is reached through llmChatWithImage.
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'capture_screen_region') return 'data:image/png;base64,AAAA';
      return undefined;
    });
    const { container } = await renderVisibleCompanion();

    vi.useFakeTimers();
    act(() => {
      fireEvent.click(avatar(container));
      fireEvent.click(avatar(container));
    });
    expect(screen.getByText('Your turn (X)')).toBeInTheDocument();

    const cells = boardCells(container);
    expect(cells).toHaveLength(9);
    act(() => {
      fireEvent.click(cells[8]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(cells[8].textContent?.trim()).toBe('X');
    expect(cells[4].textContent?.trim()).toBe('O');
    expect(consoleError).not.toHaveBeenCalled();
  });
});