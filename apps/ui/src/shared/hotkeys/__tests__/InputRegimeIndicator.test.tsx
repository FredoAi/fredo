/**
 * Spec #2960 ST-2 — the persistent input-regime chip (EARS R-1.1–R-1.4,
 * R-2.1–R-2.4, R-3.1, R-3.2).
 *
 * Pins: the exact binding constants; both regimes' text label + icon shape; the
 * chip's `data-input-regime` MATCHES the engine's `data-fredo-input-regime` on
 * every transition (including terminal → absent); the mode marker renders iff
 * navigating AND keyboard mode ON; boot does not announce and each regime
 * transition announces exactly once (same-regime re-renders stay silent); the
 * a11y discipline (aria-hidden, click-through, no focusable descendant, no live
 * region of its own); reduced-motion suppresses the fade; and the token/CSS-var
 * source hygiene (G-273 label never clipped).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { getAnnouncement, resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { resetContextRegistryForTests } from '@/shared/hotkeys/contexts';
import { resetHotkeyContextForTests } from '@/shared/hotkeys/contextStack';
import {
  BODY_INPUT_REGIME_ATTR,
  installHotkeyEngine,
  resetHotkeyEngineForTests,
} from '@/shared/hotkeys/engine';
import { inputRegimeAnnouncement } from '@/shared/hotkeys/inputRegime';
import {
  enterKeyboardMode,
  resetKeyboardModeForTests,
} from '@/shared/hotkeys/keyboardMode';
import {
  INPUT_REGIME_ATTR,
  INPUT_REGIME_LABEL_TESTID,
  INPUT_REGIME_MODE_TESTID,
  INPUT_REGIME_MODE_TEXT,
  INPUT_REGIME_TESTID,
  InputRegimeIndicator,
  REGIME_SIGNAL_Z_INDEX,
} from '../InputRegimeIndicator';

// ── Focus targets (mirror engine.test.ts) ────────────────────────────────────

function mountNeutral(): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

function mountInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  return input;
}

function mountButton(): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.appendChild(button);
  button.focus();
  return button;
}

function mountTerminal(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-fredo-terminal-root', 'true');
  const inner = document.createElement('div');
  inner.tabIndex = -1;
  root.appendChild(inner);
  document.body.appendChild(root);
  inner.focus();
  return inner;
}

// ── Queries ──────────────────────────────────────────────────────────────────

function chip(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${INPUT_REGIME_TESTID}"]`);
}

function label(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${INPUT_REGIME_LABEL_TESTID}"]`);
}

function modeMarker(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${INPUT_REGIME_MODE_TESTID}"]`);
}

beforeEach(() => {
  localStorage.clear();
  resetHotkeyAnnouncer();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
  resetHotkeyEngineForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  resetHotkeyEngineForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
});

// ── Binding constants ────────────────────────────────────────────────────────

describe('InputRegimeIndicator — binding constants', () => {
  it('declares the exact contract strings + stacking', () => {
    expect(INPUT_REGIME_TESTID).toBe('hotkeys-input-regime');
    expect(INPUT_REGIME_LABEL_TESTID).toBe('hotkeys-input-regime-label');
    expect(INPUT_REGIME_MODE_TESTID).toBe('hotkeys-input-regime-mode');
    expect(INPUT_REGIME_ATTR).toBe('data-input-regime');
    expect(REGIME_SIGNAL_Z_INDEX).toBe(1310);
    expect(INPUT_REGIME_MODE_TEXT).toBe('Keyboard mode');
  });
});

// ── Typing regime (R-1.1–R-1.3) ──────────────────────────────────────────────

describe('InputRegimeIndicator — typing regime', () => {
  it('renders the Typing label + an icon shape + typing="typing" for a text field', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);
    act(() => {
      mountInput();
    });

    const root = chip(container);
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute(INPUT_REGIME_ATTR, 'typing');
    expect(label(container)).toHaveTextContent('Typing');
    // Icon SHAPE channel: a rendered <svg>.
    expect(root!.querySelector('svg')).not.toBeNull();
    // The typing shape uses the rectangular outline (radius sm is asserted in
    // the source-hygiene block; here we pin the fixed top-left placement).
    expect(root!.style.position).toBe('fixed');
    expect(root!.style.left).toBe('12px');
    expect(root!.style.zIndex).toBe('1310');
    expect(root!.style.pointerEvents).toBe('none');
  });

  it('is aria-hidden, click-through, and declares no live region of its own', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);
    act(() => {
      mountInput();
    });

    const root = chip(container)!;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    // No focusable descendant.
    expect(
      root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'),
    ).toHaveLength(0);
  });
});

// ── Navigating regime (R-2.1, R-2.4) ─────────────────────────────────────────

describe('InputRegimeIndicator — navigating regime', () => {
  it('renders the Navigating label + a DIFFERENT icon shape for a non-text focus', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);

    // default (navigating) first.
    expect(chip(container)).toHaveAttribute(INPUT_REGIME_ATTR, 'navigating');
    const navigatingShape = chip(container)!.querySelector('svg')!.outerHTML;
    expect(label(container)).toHaveTextContent('Navigating');

    act(() => {
      mountInput();
    });
    const typingShape = chip(container)!.querySelector('svg')!.outerHTML;
    expect(typingShape).not.toBe(navigatingShape);
  });

  it('renders NOTHING for the terminal context (the shipped pill owns it, R-2.4)', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);
    act(() => {
      mountTerminal();
    });

    expect(chip(container)).toBeNull();
    expect(document.body.hasAttribute(BODY_INPUT_REGIME_ATTR)).toBe(false);
  });
});

// ── Signal == engine on every transition (R-3.1/R-3.2, NFR reliability) ──────

describe('InputRegimeIndicator — data-input-regime matches the engine hook', () => {
  it('matches data-fredo-input-regime after every focus transition', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);

    const assertMatch = (): void => {
      const root = chip(container);
      const bodyRegime = document.body.getAttribute(BODY_INPUT_REGIME_ATTR);
      if (root === null) {
        expect(bodyRegime).toBeNull();
      } else {
        expect(root).toHaveAttribute(INPUT_REGIME_ATTR, bodyRegime);
      }
    };

    assertMatch(); // default → navigating
    act(() => {
      mountInput();
    });
    assertMatch(); // text-entry → typing
    act(() => {
      mountButton();
    });
    assertMatch(); // interactive → navigating
    act(() => {
      mountTerminal();
    });
    assertMatch(); // terminal → null
    act(() => {
      mountNeutral();
    });
    assertMatch(); // default → navigating
  });

  it('R-3.2: a field→field move keeps the DOM unchanged (same snapshot identity)', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);
    act(() => {
      mountInput();
    });
    const before = chip(container);
    expect(before).toHaveAttribute(INPUT_REGIME_ATTR, 'typing');

    const second = document.createElement('input');
    document.body.appendChild(second);
    act(() => {
      second.focus();
    });

    expect(chip(container)).toBe(before); // identical node — no DOM change
    expect(chip(container)).toHaveAttribute(INPUT_REGIME_ATTR, 'typing');
  });
});

// ── Keyboard-mode marker (R-2.3) ─────────────────────────────────────────────

describe('InputRegimeIndicator — keyboard-mode marker', () => {
  it('renders the Keyboard mode marker iff navigating AND mode ON', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);

    // navigating, mode OFF → no marker.
    expect(modeMarker(container)).toBeNull();

    act(() => {
      enterKeyboardMode();
    });
    const marker = modeMarker(container);
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent(INPUT_REGIME_MODE_TEXT);
    expect(marker!.querySelector('svg')).not.toBeNull();
    expect(chip(container)).toHaveAttribute(INPUT_REGIME_ATTR, 'navigating');
  });

  it('never renders the marker while typing, even with mode ON', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });
    act(() => {
      mountInput();
    });

    expect(chip(container)).toHaveAttribute(INPUT_REGIME_ATTR, 'typing');
    expect(modeMarker(container)).toBeNull();
  });
});

// ── Announcement discipline (R-1.2/R-2.2) ────────────────────────────────────

describe('InputRegimeIndicator — announcement', () => {
  it('does NOT announce on boot', () => {
    installHotkeyEngine();
    resetHotkeyAnnouncer();
    renderWithChakra(<InputRegimeIndicator reducedMotion />);
    expect(getAnnouncement()).toBe('');
  });

  it('announces exactly once per regime transition', () => {
    installHotkeyEngine();
    renderWithChakra(<InputRegimeIndicator reducedMotion />);

    act(() => {
      mountInput();
    });
    expect(getAnnouncement()).toBe(inputRegimeAnnouncement('typing'));

    act(() => {
      mountButton();
    });
    expect(getAnnouncement()).toBe(inputRegimeAnnouncement('navigating'));
  });

  it('stays silent on a same-regime re-render (mode toggle) and on terminal', () => {
    installHotkeyEngine();
    renderWithChakra(<InputRegimeIndicator reducedMotion />);

    // default navigating → clear the channel, then a mode toggle re-renders but
    // the regime is unchanged → no re-announcement.
    resetHotkeyAnnouncer();
    act(() => {
      enterKeyboardMode();
    });
    expect(getAnnouncement()).toBe('');

    // Entering the terminal (regime null) is silent.
    act(() => {
      mountTerminal();
    });
    expect(getAnnouncement()).toBe('');

    // Leaving the terminal back to navigating announces the regime once.
    act(() => {
      mountNeutral();
    });
    expect(getAnnouncement()).toBe(inputRegimeAnnouncement('navigating'));
  });
});

// ── Reduced motion (NFR-1) ───────────────────────────────────────────────────

describe('InputRegimeIndicator — reduced motion', () => {
  it('suppresses the fade under prefers-reduced-motion', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator reducedMotion />);
    act(() => {
      mountInput();
    });
    const root = chip(container)!;
    expect(root.style.animation).toBe('none');
    expect(root.style.transition).toBe('none');
  });

  it('applies an opacity fade when motion is allowed', () => {
    installHotkeyEngine();
    const { container } = renderWithChakra(<InputRegimeIndicator />);
    act(() => {
      mountInput();
    });
    const root = chip(container)!;
    expect(root.style.animation).toContain('hotkeys-input-regime-fade');
  });
});

// ── Source hygiene (token + CSS-var + G-273 label) ───────────────────────────

describe('InputRegimeIndicator — source hygiene', () => {
  const SOURCE_PATH = 'src/shared/hotkeys/InputRegimeIndicator.tsx';

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

  it('uses the shared tint() + semantic tokens and declares no live region', () => {
    const code = readSource();
    expect(code).toContain('tint(');
    expect(code).toContain('bg="bg.subtle"');
    expect(code).toContain('border.subtle');
    expect(code).toContain('border.default');
    expect(code).toContain('borderRadius');
    expect(code).toContain('pointerEvents');
    expect(code).toContain('data-input-regime');
    expect(code).not.toContain('aria-live');
    expect(code).not.toContain('role="status"');
  });

  it('G-273: the chip label is flexShrink={0} + whiteSpace="nowrap" (never clipped)', () => {
    const code = readSource();
    expect(code).toContain('whiteSpace="nowrap"');
    expect(code).toContain('flexShrink={0}');
  });
});
