/**
 * Canvas palette contract (Spec #3070, ST-2, UI/UX section 8).
 *
 * Pins the 12 contracted keys -> CSS variable mapping, the missing-variable
 * fallback, and the MutationObserver re-resolve when the theme writes new
 * values. `getComputedStyle` is stubbed so the assertions are deterministic in
 * jsdom (no real theme mount).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  CANVAS_PALETTE_KEYS,
  CANVAS_PALETTE_VARS,
  canvasPalettesEqual,
  resolveCanvasPalette,
  useCanvasPalette,
} from '../theme/useCanvasPalette';

let variables: Record<string, string> = {};
let originalGetComputedStyle: typeof window.getComputedStyle;

function installComputedStyleStub(): void {
  originalGetComputedStyle = window.getComputedStyle.bind(window);

  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    ((element: Element, pseudo?: string | null) => {
      const real = originalGetComputedStyle(element, pseudo ?? undefined);
      if (element !== document.documentElement) return real;

      return new Proxy(real, {
        get(target, property, receiver) {
          if (property === 'getPropertyValue') {
            return (name: string) => variables[name] ?? '';
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    }) as typeof window.getComputedStyle,
  );
}

/**
 * The offscreen probe used to concretise derived `color-mix(...)` tokens emits a
 * resolved colour from its `color` computed style (jsdom does not resolve
 * color-mix itself, so the test stubs the resolved value).
 */
function stubProbeColor(): void {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    ((element: Element, pseudo?: string | null) => {
      const real = original(element, pseudo ?? undefined);
      if (
        element !== document.documentElement &&
        element.getAttribute('data-canvas-color-probe') !== null
      ) {
        return new Proxy(real, {
          get(target, property, receiver) {
            if (property === 'color') return 'resolved-probe-color';
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as CSSStyleDeclaration;
      }
      if (element !== document.documentElement) return real;
      return new Proxy(real, {
        get(target, property, receiver) {
          if (property === 'getPropertyValue') {
            return (name: string) => variables[name] ?? '';
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    }) as typeof window.getComputedStyle,
  );
}

beforeEach(() => {
  variables = {
    '--card-bg': 'token-surface',
    '--card-hover-bg': 'token-muted',
    '--border-color': 'token-border',
    '--text-primary': 'token-text',
    '--text-secondary': 'token-text-muted',
    '--accent-primary': 'token-accent',
    '--status-success': 'token-success',
    '--status-warning': 'token-warning',
    '--status-error': 'token-error',
    '--status-info': 'token-info',
    '--accent-contrast': 'token-on-accent',
    '--accent-strong': 'token-focus-ring',
  };
  installComputedStyleStub();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
});

describe('palette contract', () => {
  it('resolves exactly the 12 contracted keys', () => {
    expect(CANVAS_PALETTE_KEYS).toHaveLength(12);
    expect(Object.keys(CANVAS_PALETTE_VARS).sort()).toEqual([...CANVAS_PALETTE_KEYS].sort());
  });

  it('maps every key to its binding CSS variable', () => {
    expect(CANVAS_PALETTE_VARS).toEqual({
      surface: '--card-bg',
      muted: '--card-hover-bg',
      border: '--border-color',
      text: '--text-primary',
      textMuted: '--text-secondary',
      accent: '--accent-primary',
      success: '--status-success',
      warning: '--status-warning',
      error: '--status-error',
      info: '--status-info',
      onAccent: '--accent-contrast',
      focusRing: '--accent-strong',
    });
  });

  it('resolves each key from the live theme variables', () => {
    expect(resolveCanvasPalette()).toEqual({
      surface: 'token-surface',
      muted: 'token-muted',
      border: 'token-border',
      text: 'token-text',
      textMuted: 'token-text-muted',
      accent: 'token-accent',
      success: 'token-success',
      warning: 'token-warning',
      error: 'token-error',
      info: 'token-info',
      onAccent: 'token-on-accent',
      focusRing: 'token-focus-ring',
    });
  });

  it('falls back to the CSS keyword when a variable is missing', () => {
    delete variables['--card-bg'];
    expect(resolveCanvasPalette().surface).toBe('transparent');
  });

  it('concretises derived color-mix tokens through an offscreen probe', () => {
    variables['--accent-strong'] =
      'color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary) 45%)';
    stubProbeColor();

    expect(resolveCanvasPalette().focusRing).toBe('resolved-probe-color');

    const probe = document.querySelector('[data-canvas-color-probe]');
    expect(probe).not.toBeNull();
    expect(probe).toHaveAttribute('aria-hidden', 'true');
  });

  it('compares palette value identity', () => {
    const first = resolveCanvasPalette();
    const second = { ...first };
    expect(canvasPalettesEqual(first, second)).toBe(true);
    expect(canvasPalettesEqual(first, { ...first, accent: 'token-other' })).toBe(false);
  });
});

describe('useCanvasPalette', () => {
  it('re-resolves when the theme writes a new variable and keeps identity otherwise', async () => {
    const { result } = renderHook(() => useCanvasPalette());
    const initial = result.current;
    expect(initial.surface).toBe('token-surface');

    // A style mutation that does not change a palette value keeps the object.
    act(() => {
      document.documentElement.style.setProperty('--body-bg', 'token-body');
    });
    await Promise.resolve();
    expect(result.current).toBe(initial);

    variables['--card-bg'] = 'token-surface-dark';
    act(() => {
      document.documentElement.style.setProperty('--card-bg', 'token-surface-dark');
    });

    await waitFor(() => {
      expect(result.current.surface).toBe('token-surface-dark');
    });
    expect(result.current).not.toBe(initial);
  });
});
