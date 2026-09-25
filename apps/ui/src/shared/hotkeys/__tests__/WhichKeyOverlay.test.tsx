/**
 * Spec #2946 ST-5 — which-key pending-sequence overlay pins (EARS R-3.2).
 *
 * Covers: hidden-when-idle, the empty-prefix / empty-candidates HIDDEN
 * adjudication (completion must show nothing), pending prefix + valid-next rows,
 * invalid + timeout reset testids, `pointerEvents:'none'`, `aria-hidden` visual
 * root with NO live region, the ST-3 announcer digest, the G-253 dock-derived
 * bottom offset, and the reduced-motion nudge gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { getAnnouncement, resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { registerFredoAction, resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import {
  installHotkeyEngine,
  resetHotkeyEngineForTests,
} from '@/shared/hotkeys/engine';
import {
  clearPendingSequence,
  resetKeymapStoreForTests,
  setPendingSequence,
} from '@/shared/hotkeys/store';
import { HotkeysProvider } from '@/shared/hotkeys/HotkeysProvider';
import {
  WHICHKEY_DOCK_SELECTOR,
  WHICHKEY_INVALID_TESTID,
  WHICHKEY_MAX_ANNOUNCED_CANDIDATES,
  WHICHKEY_MIN_BOTTOM_PX,
  WHICHKEY_NEXT_ITEM_TESTID,
  WHICHKEY_NEXT_LIST_TESTID,
  WHICHKEY_NUDGE_MS,
  WHICHKEY_OVERLAY_TESTID,
  WHICHKEY_PREFIX_TESTID,
  WHICHKEY_TIMEOUT_TESTID,
  WhichKeyOverlay,
  measureBottomOffsetPx,
  pendingAnnouncement,
  resetAnnouncement,
} from '../WhichKeyOverlay';
import type { HotkeyCandidate } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function candidate(
  strokeToken: string,
  title: string,
  tier: HotkeyCandidate['tier'] = 'fredo',
): HotkeyCandidate {
  return {
    strokeToken,
    display: strokeToken === 'g' ? 'G' : strokeToken === 'h' ? 'H' : strokeToken,
    actionId: `fredo.test.${strokeToken}`,
    title,
    tier,
  };
}

const G = candidate('g', 'Go to top');
const H = candidate('h', 'Focus left');

function mountDock(rect: { top: number; bottom: number }, visibility?: string): HTMLElement {
  const dock = document.createElement('div');
  dock.setAttribute('data-testid', 'app-dock');
  if (visibility) dock.style.visibility = visibility;
  dock.getBoundingClientRect = () =>
    ({
      top: rect.top,
      bottom: rect.bottom,
      left: 0,
      right: 100,
      width: 100,
      height: rect.bottom - rect.top,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(dock);
  return dock;
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  resetHotkeyEngineForTests();
  resetHotkeyAnnouncer();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function overlay(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${WHICHKEY_OVERLAY_TESTID}"]`);
}

// ── Renders only for a NON-empty pending sequence ────────────────────────────

describe('WhichKeyOverlay — visibility gate', () => {
  it('renders nothing when idle', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    expect(overlay(container)).toBeNull();
  });

  it('stays hidden when the pending prefix is EMPTY (completion projection)', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('', [G]));
    expect(overlay(container)).toBeNull();
  });

  it('stays hidden when the candidate list is empty', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', []));
    expect(overlay(container)).toBeNull();
  });

  it('a completed sequence (empty prefix + no candidates) shows NOTHING and no reset flash', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    expect(overlay(container)).not.toBeNull();

    act(() => setPendingSequence('', []));
    expect(overlay(container)).toBeNull();
    expect(container.querySelector(`[data-testid="${WHICHKEY_INVALID_TESTID}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="${WHICHKEY_TIMEOUT_TESTID}"]`)).toBeNull();
  });
});

// ── Pending state: prefix + valid-next rows ──────────────────────────────────

describe('WhichKeyOverlay — pending state (R-3.2)', () => {
  it('renders the pending prefix as Keycap chips and a wrapped valid-next grid', () => {
    const { container, getByTestId } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G, H]));

    expect(overlay(container)).not.toBeNull();
    expect(getByTestId(WHICHKEY_PREFIX_TESTID)).toHaveTextContent('G');
    expect(getByTestId(WHICHKEY_NEXT_LIST_TESTID)).toBeInTheDocument();

    const items = container.querySelectorAll<HTMLElement>(
      `[data-testid="${WHICHKEY_NEXT_ITEM_TESTID}"]`,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('G');
    expect(items[0]).toHaveTextContent('Go to top');
    expect(items[0]).toHaveTextContent('Global');
    expect(items[1]).toHaveTextContent('H');
    expect(items[1]).toHaveTextContent('Focus left');
  });

  it('labels a feature-tier candidate as Feature', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [candidate('x', 'Demo action', 'feature')]));

    const item = container.querySelector<HTMLElement>(
      `[data-testid="${WHICHKEY_NEXT_ITEM_TESTID}"]`,
    );
    expect(item).toHaveTextContent('Feature');
  });

  it('renders the overlay synchronously on the store change (no async gate)', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    expect(overlay(container)).toBeNull();
    act(() => setPendingSequence('g', [G]));
    // Same tick as the mutation — the <=100 ms budget is structural.
    expect(overlay(container)).not.toBeNull();
  });

  it('shows the accumulated prefix for a multi-key sequence', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g g', [G]));
    expect(container.querySelector(`[data-testid="${WHICHKEY_PREFIX_TESTID}"]`)).toHaveTextContent(
      'G',
    );
  });
});

// ── Invalid / timeout reset states ───────────────────────────────────────────

describe('WhichKeyOverlay — invalid / timeout reset', () => {
  it('shows the invalid reset (icon + explicit text) after a dead-end key', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g g', [G]));
    act(() => clearPendingSequence('invalid'));

    const invalid = container.querySelector<HTMLElement>(
      `[data-testid="${WHICHKEY_INVALID_TESTID}"]`,
    );
    expect(invalid).not.toBeNull();
    expect(invalid).toHaveTextContent('No binding for G then G — sequence cancelled');
    // The pending prefix is gone; the reset lives in the overlay root.
    expect(container.querySelector(`[data-testid="${WHICHKEY_PREFIX_TESTID}"]`)).toBeNull();
    expect(overlay(container)).not.toBeNull();
  });

  it('shows the timeout reset after the sequence times out', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    act(() => clearPendingSequence('timeout'));

    const timeout = container.querySelector<HTMLElement>(
      `[data-testid="${WHICHKEY_TIMEOUT_TESTID}"]`,
    );
    expect(timeout).not.toBeNull();
    expect(timeout).toHaveTextContent('Sequence timed out');
  });

  it('clears the reset flash after the flash window', () => {
    vi.useFakeTimers();
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    act(() => clearPendingSequence('invalid'));
    expect(container.querySelector(`[data-testid="${WHICHKEY_INVALID_TESTID}"]`)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(container.querySelector(`[data-testid="${WHICHKEY_INVALID_TESTID}"]`)).toBeNull();
    expect(overlay(container)).toBeNull();
  });

  it('Escape / focus-change resets show NO invalid or timeout flash', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    act(() => clearPendingSequence('escape'));

    expect(overlay(container)).toBeNull();
    expect(container.querySelector(`[data-testid="${WHICHKEY_INVALID_TESTID}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="${WHICHKEY_TIMEOUT_TESTID}"]`)).toBeNull();
  });
});

// ── Pointer + accessibility invariants ───────────────────────────────────────

describe('WhichKeyOverlay — pointer + a11y invariants', () => {
  it('never steals a click (pointerEvents:none) and is an aria-hidden visual', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));

    const root = overlay(container);
    expect(root).not.toBeNull();
    expect(root?.style.pointerEvents).toBe('none');
    expect(root).toHaveAttribute('aria-hidden', 'true');
  });

  it('declares NO live region (the ST-3 announcer owns the speech)', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));

    expect(overlay(container)?.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(overlay(container)?.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});

// ── Announcer digest ─────────────────────────────────────────────────────────

describe('WhichKeyOverlay — announcer digest', () => {
  it('announces the pending prefix + valid next keys', () => {
    renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G, H]));

    const digest = getAnnouncement();
    expect(digest).toContain('Prefix: G.');
    expect(digest).toContain('Valid next keys: G (Go to top), H (Focus left).');
  });

  it('bounds the digest to the first N candidates + "and M more"', () => {
    const many = Array.from({ length: WHICHKEY_MAX_ANNOUNCED_CANDIDATES + 2 }, (_, i) =>
      candidate(`k${i}`, `Action ${i}`),
    );
    const digest = pendingAnnouncement('g', many, 'win32');
    expect(digest).toContain('and 2 more');
    expect(digest).not.toContain('Action 9');
  });

  it('announces the invalid and timeout reset copy', () => {
    resetHotkeyAnnouncer();
    renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    act(() => clearPendingSequence('invalid'));
    expect(getAnnouncement()).toBe('No binding for G — sequence cancelled');

    act(() => setPendingSequence('g', [G]));
    act(() => clearPendingSequence('timeout'));
    expect(getAnnouncement()).toBe('Sequence timed out');
  });

  it('does not announce an empty-prefix completion', () => {
    renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    const before = getAnnouncement();
    resetHotkeyAnnouncer();
    act(() => setPendingSequence('', []));
    expect(getAnnouncement()).toBe('');
    expect(before).toContain('Prefix: G.');
  });

  it('builds reset copy directly', () => {
    expect(resetAnnouncement('invalid', 'g g', 'win32')).toBe(
      'No binding for G then G — sequence cancelled',
    );
    expect(resetAnnouncement('timeout', 'g', 'win32')).toBe('Sequence timed out');
  });
});

// ── G-253: offset derived from the ACTUAL rendered dock stack ────────────────

describe('WhichKeyOverlay — bottom offset derives from the rendered dock (G-253)', () => {
  it('uses the base inset when no dock is rendered', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    expect(overlay(container)?.style.bottom).toBe(`${WHICHKEY_MIN_BOTTOM_PX}px`);
    expect(measureBottomOffsetPx()).toBe(WHICHKEY_MIN_BOTTOM_PX);
  });

  it('clears the ACTUAL rendered bottom dock via its live rect (never a nominal sum)', () => {
    mountDock({ top: 730, bottom: 788 });
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));

    // 800 (viewport) − 730 (real dock top, including border/padding) + 16 (gap).
    expect(overlay(container)?.style.bottom).toBe('86px');
  });

  it('uses the base inset for a hidden (edge-peek) dock', () => {
    mountDock({ top: 730, bottom: 788 }, 'hidden');
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    expect(overlay(container)?.style.bottom).toBe(`${WHICHKEY_MIN_BOTTOM_PX}px`);
  });

  it('uses the base inset for a side-rail dock (not anchored to the bottom)', () => {
    mountDock({ top: 300, bottom: 400 });
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    expect(overlay(container)?.style.bottom).toBe(`${WHICHKEY_MIN_BOTTOM_PX}px`);
  });

  it('scans the documented dock selector', () => {
    expect(WHICHKEY_DOCK_SELECTOR).toBe('[data-testid="app-dock"]');
  });
});

// ── Reduced motion ───────────────────────────────────────────────────────────

describe('WhichKeyOverlay — reduced-motion nudge gate', () => {
  it('plays the <=150 ms nudge by default', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);
    act(() => setPendingSequence('g', [G]));
    act(() => clearPendingSequence('invalid'));

    const invalid = container.querySelector<HTMLElement>(
      `[data-testid="${WHICHKEY_INVALID_TESTID}"]`,
    );
    expect(invalid?.style.animation).toContain(`${WHICHKEY_NUDGE_MS}ms`);
    expect(WHICHKEY_NUDGE_MS).toBeLessThanOrEqual(150);
  });

  it('disables the nudge under prefers-reduced-motion', () => {
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" reducedMotion />);
    act(() => setPendingSequence('g', [G]));
    act(() => clearPendingSequence('timeout'));

    const timeout = container.querySelector<HTMLElement>(
      `[data-testid="${WHICHKEY_TIMEOUT_TESTID}"]`,
    );
    expect(timeout?.style.animation).toBe('none');
  });
});

// ── Mount wiring (HotkeysProvider) ───────────────────────────────────────────

describe('WhichKeyOverlay — mounted with the engine', () => {
  it('renders through HotkeysProvider and unmounts cleanly', () => {
    const { container, unmount } = renderWithChakra(
      <HotkeysProvider>
        <span />
      </HotkeysProvider>,
    );
    act(() => setPendingSequence('g', [G]));
    expect(overlay(container)).not.toBeNull();
    unmount();
    expect(overlay(container)).toBeNull();
  });
});

// ── Engine integration (the overlay is driven by the real dispatch path) ─────

describe('WhichKeyOverlay — engine integration', () => {
  function registerSequence(run: ReturnType<typeof vi.fn>): void {
    registerFredoAction({
      actionId: 'fredo.test.gg',
      title: 'Go go',
      defaultSequence: 'g g',
      run,
    });
  }

  function press(key: string): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  it('an invalid continuation fires NO action and shows the invalid reset', () => {
    const run = vi.fn();
    registerSequence(run);
    installHotkeyEngine();
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);

    act(() => press('g'));
    expect(container.querySelector(`[data-testid="${WHICHKEY_PREFIX_TESTID}"]`)).not.toBeNull();

    act(() => press('x'));
    expect(run).not.toHaveBeenCalled();
    expect(
      container.querySelector(`[data-testid="${WHICHKEY_INVALID_TESTID}"]`),
    ).not.toBeNull();
  });

  it('a timeout fires NO action and shows the timeout reset', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    registerSequence(run);
    installHotkeyEngine();
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);

    act(() => press('g'));
    expect(container.querySelector(`[data-testid="${WHICHKEY_PREFIX_TESTID}"]`)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(run).not.toHaveBeenCalled();
    expect(
      container.querySelector(`[data-testid="${WHICHKEY_TIMEOUT_TESTID}"]`),
    ).not.toBeNull();
  });

  it('a completed sequence fires the action once and shows nothing', () => {
    const run = vi.fn();
    registerSequence(run);
    installHotkeyEngine();
    const { container } = renderWithChakra(<WhichKeyOverlay platform="win32" />);

    act(() => press('g'));
    expect(overlay(container)).not.toBeNull();

    act(() => press('g'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(overlay(container)).toBeNull();
    expect(container.querySelector(`[data-testid="${WHICHKEY_INVALID_TESTID}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="${WHICHKEY_TIMEOUT_TESTID}"]`)).toBeNull();
  });
});

// ── Source audit (token hygiene + no live region + no length deps) ───────────

const OVERLAY_SOURCE = 'src/shared/hotkeys/WhichKeyOverlay.tsx';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('WhichKeyOverlay — source audit', () => {
  const code = stripComments(readFileSync(resolve(process.cwd(), OVERLAY_SOURCE), 'utf8'));

  it('scans the real file (guards against a vacuous pass)', () => {
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain('WHICHKEY_OVERLAY_TESTID');
  });

  it('has no hex / rgb() / hsl() colour literal in code', () => {
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0])).toEqual([]);
  });

  it('has no var(--x)NN alpha-append and uses the shared tint() helper', () => {
    expect([...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0])).toEqual([]);
    expect(code).toContain('tint(');
  });

  it('declares no aria-live / role="status" (the ONE announcer owns the speech)', () => {
    expect(code).not.toContain('aria-live');
    expect(code).not.toContain('role="status"');
    expect(code).toContain('aria-hidden="true"');
  });

  it('does not depend on `.length` inside an effect/memo dependency array (#523)', () => {
    const depsWithLength = [...code.matchAll(/\[[^[\]]*\.length[^[\]]*\]/g)].map((m) => m[0]);
    expect(depsWithLength, JSON.stringify(depsWithLength)).toEqual([]);
  });
});
