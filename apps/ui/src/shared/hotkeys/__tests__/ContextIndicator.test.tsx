/**
 * Spec #2958 ST-4 — the non-colour-only context-change indicator (EARS R-4.1 +
 * the visual half of R-4.2).
 *
 * Pins: the exact binding constants, the visibility gate (idle base-passthrough
 * and refused/missing descent targets render nothing), the three non-colour
 * channels (title text + direction icon shape + depth pips), the dwell
 * transience (≥1500 ms legible, ≤300 ms fade, reduced motion hides with no
 * animation), the a11y discipline (aria-hidden visual, NO second live region),
 * the #523 no-render-loop rule, and the token/CSS-var source hygiene.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import {
  registerHotkeyContext,
  resetContextRegistryForTests,
} from '@/shared/hotkeys/contexts';
import {
  enterHotkeyContext,
  exitHotkeyContext,
  getActiveHotkeyContext,
  resetHotkeyContextForTests,
} from '@/shared/hotkeys/contextStack';
import { ROOT_CONTEXT_ID } from '@/shared/hotkeys/types';
import {
  CONTEXT_INDICATOR_DWELL_MS,
  CONTEXT_INDICATOR_FADE_MS,
  CONTEXT_INDICATOR_Z_INDEX,
  ContextIndicator,
  HOTKEY_CONTEXT_INDICATOR_ATTR,
  HOTKEY_CONTEXT_INDICATOR_DEPTH_TESTID,
  HOTKEY_CONTEXT_INDICATOR_LABEL_TESTID,
  HOTKEY_CONTEXT_INDICATOR_PIP_TESTID,
  HOTKEY_CONTEXT_INDICATOR_TESTID,
} from '../ContextIndicator';

const CHILD = 'fredo.test.child';
const GRAND = 'fredo.test.child.grand';
const MISSING = 'fredo.test.nope';

function registerContexts(): void {
  registerHotkeyContext({ contextId: CHILD, parentId: ROOT_CONTEXT_ID, title: 'Child' });
  registerHotkeyContext({ contextId: GRAND, parentId: CHILD, title: 'Grandchild' });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetContextRegistryForTests();
  resetHotkeyAnnouncer();
  resetHotkeyContextForTests();
  registerContexts();
});

afterEach(() => {
  cleanup();
  resetHotkeyContextForTests();
  resetContextRegistryForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function indicator(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${HOTKEY_CONTEXT_INDICATOR_TESTID}"]`);
}

function label(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-testid="${HOTKEY_CONTEXT_INDICATOR_LABEL_TESTID}"]`,
  );
}

function depth(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-testid="${HOTKEY_CONTEXT_INDICATOR_DEPTH_TESTID}"]`,
  );
}

function pips(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll(`[data-testid="${HOTKEY_CONTEXT_INDICATOR_PIP_TESTID}"]`);
}

// ── Binding constants ────────────────────────────────────────────────────────

describe('ContextIndicator — binding constants', () => {
  it('declares the exact contract strings + timing/stacking', () => {
    expect(HOTKEY_CONTEXT_INDICATOR_TESTID).toBe('hotkeys-context-indicator');
    expect(HOTKEY_CONTEXT_INDICATOR_LABEL_TESTID).toBe('hotkeys-context-indicator-label');
    expect(HOTKEY_CONTEXT_INDICATOR_DEPTH_TESTID).toBe('hotkeys-context-indicator-depth');
    expect(HOTKEY_CONTEXT_INDICATOR_ATTR).toBe('data-hotkey-context');
    expect(CONTEXT_INDICATOR_DWELL_MS).toBeGreaterThanOrEqual(1500);
    expect(CONTEXT_INDICATOR_FADE_MS).toBeLessThanOrEqual(300);
    expect(CONTEXT_INDICATOR_Z_INDEX).toBe(1350);
  });
});

// ── Visibility gate ──────────────────────────────────────────────────────────

describe('ContextIndicator — visibility gate', () => {
  it('renders nothing while idle (no context change since mount)', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    expect(indicator(container)).toBeNull();
  });

  it('renders on a real change with all THREE non-colour channels', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    act(() => {
      enterHotkeyContext(CHILD);
    });

    const pill = indicator(container);
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute(HOTKEY_CONTEXT_INDICATOR_ATTR, CHILD);
    expect(pill).toHaveAttribute('data-direction', 'enter');

    // (1) title text
    expect(label(container)).toHaveTextContent('Child');
    // (2) direction icon shape (a rendered <svg>)
    expect(pill!.querySelector('svg')).not.toBeNull();
    // (3) depth pips — one per path level (base = 1, child = 2)
    expect(depth(container)).toHaveAttribute('data-depth', '2');
    expect(pips(container)).toHaveLength(2);
  });

  it('increments depth pips and swaps the label for a nested descent', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    act(() => {
      enterHotkeyContext(CHILD);
    });
    act(() => {
      enterHotkeyContext(GRAND);
    });

    expect(indicator(container)).toHaveAttribute(HOTKEY_CONTEXT_INDICATOR_ATTR, GRAND);
    expect(label(container)).toHaveTextContent('Grandchild');
    expect(depth(container)).toHaveAttribute('data-depth', '3');
    expect(pips(container)).toHaveLength(3);
  });

  it('renders nothing for a refused / missing descent target (no fall-through pill)', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    let entered = true;
    act(() => {
      entered = enterHotkeyContext(MISSING);
    });
    expect(entered).toBe(false);
    expect(indicator(container)).toBeNull();
    expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);
  });

  it('renders nothing at a base-passthrough (Escape at the base is a no-op)', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    let exited = true;
    act(() => {
      exited = exitHotkeyContext();
    });
    expect(exited).toBe(false);
    expect(indicator(container)).toBeNull();
  });

  it('shows the back direction + the parent label on an unwind', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    act(() => {
      enterHotkeyContext(CHILD);
    });
    // Let the descent pill hide first so the re-show is unambiguous.
    act(() => {
      vi.advanceTimersByTime(CONTEXT_INDICATOR_DWELL_MS);
    });
    expect(indicator(container)).toBeNull();

    act(() => {
      exitHotkeyContext();
    });
    const pill = indicator(container);
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute('data-direction', 'back');
    expect(pill).toHaveAttribute(HOTKEY_CONTEXT_INDICATOR_ATTR, ROOT_CONTEXT_ID);
    expect(label(container)).toHaveTextContent('Fredo');
    expect(depth(container)).toHaveAttribute('data-depth', '1');
    expect(pips(container)).toHaveLength(1);
  });
});

// ── Transience (R-4.1 dwell) ─────────────────────────────────────────────────

describe('ContextIndicator — transient dwell-then-hide', () => {
  it('stays legible for at least the dwell, then hides (≤300 ms fade)', () => {
    const { container } = renderWithChakra(<ContextIndicator />);
    act(() => {
      enterHotkeyContext(CHILD);
    });
    expect(indicator(container)).not.toBeNull();
    // The fade begins at dwell - fade; the pill must survive the full dwell.
    act(() => {
      vi.advanceTimersByTime(CONTEXT_INDICATOR_DWELL_MS - 1);
    });
    expect(indicator(container)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(indicator(container)).toBeNull();
  });

  it('hides WITHOUT animation under prefers-reduced-motion', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    act(() => {
      enterHotkeyContext(CHILD);
    });
    const pill = indicator(container);
    expect(pill).not.toBeNull();
    expect(pill!.style.transition).toBe('none');

    act(() => {
      vi.advanceTimersByTime(CONTEXT_INDICATOR_DWELL_MS - 1);
    });
    expect(indicator(container)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(indicator(container)).toBeNull();
  });

  it('applies an opacity transition (≤300 ms) when motion is allowed', () => {
    const { container } = renderWithChakra(<ContextIndicator />);
    act(() => {
      enterHotkeyContext(CHILD);
    });
    const pill = indicator(container);
    expect(pill!.style.transition).toContain('opacity');
    expect(pill!.style.transition).toContain(`${CONTEXT_INDICATOR_FADE_MS}ms`);
  });
});

// ── a11y discipline ──────────────────────────────────────────────────────────

describe('ContextIndicator — no second live region', () => {
  it('is aria-hidden, click-through, and declares no live region', () => {
    const { container } = renderWithChakra(<ContextIndicator reducedMotion />);
    act(() => {
      enterHotkeyContext(CHILD);
    });
    const pill = indicator(container)!;
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(pill.style.pointerEvents).toBe('none');
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});

// ── No re-render loop (#523 rule) ────────────────────────────────────────────

describe('ContextIndicator — settles without a re-render loop', () => {
  it('shows on change, hides after the dwell, and never re-fires on its own', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = renderWithChakra(<ContextIndicator />);
    act(() => {
      enterHotkeyContext(CHILD);
    });
    expect(indicator(container)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(CONTEXT_INDICATOR_DWELL_MS + CONTEXT_INDICATOR_FADE_MS + 1);
    });
    expect(indicator(container)).toBeNull();

    // Further elapsed time must not resurrect it — no self-sustaining loop.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(indicator(container)).toBeNull();

    const messages = errorSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(messages.some((message) => message.includes('Maximum update depth'))).toBe(false);
  });
});

// ── Source hygiene (token + CSS-var + a11y) ──────────────────────────────────

describe('ContextIndicator — source hygiene', () => {
  const SOURCE_PATH = 'src/shared/hotkeys/ContextIndicator.tsx';

  function readSource(): string {
    return readFileSync(resolve(process.cwd(), SOURCE_PATH), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('has no hex / rgb() / hsl() literal and no var() alpha-append', () => {
    const code = readSource();
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])).toEqual([]);
    expect([...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((match) => match[0])).toEqual([]);
    expect([...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((match) => match[0])).toEqual([]);
  });

  it('uses the shared tint() helper + semantic tokens and declares no live region', () => {
    const code = readSource();
    expect(code).toContain('tint(');
    expect(code).toContain('bg="bg.surface"');
    expect(code).toContain('borderColor="border.default"');
    expect(code).toContain('color="fg.default"');
    expect(code).toContain('pointerEvents');
    expect(code).toContain('data-hotkey-context');
    expect(code).not.toContain('aria-live');
    expect(code).not.toContain('role="status"');
  });
});
