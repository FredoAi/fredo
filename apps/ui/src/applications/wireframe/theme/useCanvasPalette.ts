/**
 * Canvas palette (Spec #3070, ST-2, UI/UX section 8).
 *
 * Konva cannot consume `var(--x)` in a fill/stroke — it needs a concrete colour
 * at paint time. The palette resolves the 12 contracted theme variables from
 * `document.documentElement` (the shipped `useDiagram` pattern) and re-resolves
 * when the theme writes new values (the ThemeProvider sets them as inline
 * style properties, plus the doom-mode class).
 *
 * Palette = 10 document colour tokens + `onAccent` + `focusRing`
 * (SI adjudication 4). No colour literal exists in this file: the only
 * fallback is the CSS keyword `transparent` for a missing variable.
 */

import { useEffect, useState } from 'react';

/** The 12 contracted palette keys (C9). */
export type CanvasPaletteKey =
  | 'surface'
  | 'muted'
  | 'border'
  | 'text'
  | 'textMuted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'onAccent'
  | 'focusRing';

/** Resolved paint-time colours. */
export type CanvasPalette = Readonly<Record<CanvasPaletteKey, string>>;

/** Palette key -> theme CSS custom property (UI/UX section 8). */
export const CANVAS_PALETTE_VARS: Readonly<Record<CanvasPaletteKey, string>> = {
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
};

/** Stable key order (the 12 contracted keys). */
export const CANVAS_PALETTE_KEYS: readonly CanvasPaletteKey[] = [
  'surface',
  'muted',
  'border',
  'text',
  'textMuted',
  'accent',
  'success',
  'warning',
  'error',
  'info',
  'onAccent',
  'focusRing',
];

/**
 * Degenerate fallback when a variable is absent (a theme is not mounted yet).
 * A CSS keyword rather than a colour literal — the palette never invents a hue.
 */
export const CANVAS_PALETTE_FALLBACK = 'transparent';

/** Attributes whose mutation can change a theme variable. */
const OBSERVED_ATTRIBUTES = [
  'style',
  'class',
  'data-theme',
  'data-accent',
  'data-color-mode',
  'data-theme-preset',
  'data-doom-mode',
] as const;

function readVariable(styles: CSSStyleDeclaration, name: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : CANVAS_PALETTE_FALLBACK;
}

/**
 * Derived theme tokens are stored as LIVE `color-mix(... var(--x) ...)`
 * expressions (e.g. `--accent-strong`). Canvas accepts only concrete colours, so
 * such values are resolved through an offscreen element's `color` computed
 * style. Values that are already concrete (authored presets/overrides) pass
 * through untouched — no DOM round trip for the common case.
 */
const COLOR_FUNCTION_PATTERN = /(?:var|color-mix)\(/i;

let colorProbe: HTMLSpanElement | null = null;

function getColorProbe(): HTMLSpanElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (!colorProbe || !colorProbe.isConnected) {
    colorProbe = document.createElement('span');
    colorProbe.setAttribute('aria-hidden', 'true');
    colorProbe.setAttribute('data-canvas-color-probe', '');
    colorProbe.style.position = 'absolute';
    colorProbe.style.width = '0';
    colorProbe.style.height = '0';
    colorProbe.style.visibility = 'hidden';
    colorProbe.style.pointerEvents = 'none';
    document.body.appendChild(colorProbe);
  }
  return colorProbe;
}

function resolveConcreteColor(raw: string): string {
  if (!COLOR_FUNCTION_PATTERN.test(raw)) return raw;
  const probe = getColorProbe();
  if (!probe) return raw;

  probe.style.color = '';
  probe.style.color = raw;

  const resolved = getComputedStyle(probe).color.trim();
  probe.style.color = '';
  return resolved.length > 0 ? resolved : raw;
}

/** Resolve the 12 palette colours from the live theme variables. */
export function resolveCanvasPalette(): CanvasPalette {
  const styles = getComputedStyle(document.documentElement);
  const palette = {} as Record<CanvasPaletteKey, string>;
  for (const key of CANVAS_PALETTE_KEYS) {
    palette[key] = resolveConcreteColor(readVariable(styles, CANVAS_PALETTE_VARS[key]));
  }
  return palette;
}

/** True when two resolved palettes are value-identical. */
export function canvasPalettesEqual(a: CanvasPalette, b: CanvasPalette): boolean {
  return CANVAS_PALETTE_KEYS.every((key) => a[key] === b[key]);
}

/**
 * The canvas palette, re-resolved on theme/preset/accent changes. Returns a
 * stable object reference until a value actually changes, so a theme mutation
 * that leaves the palette alone does not repaint the canvas.
 */
export function useCanvasPalette(): CanvasPalette {
  const [palette, setPalette] = useState<CanvasPalette>(() => resolveCanvasPalette());

  useEffect(() => {
    const root = document.documentElement;

    const refresh = (): void => {
      const next = resolveCanvasPalette();
      setPalette((previous) => (canvasPalettesEqual(previous, next) ? previous : next));
    };

    refresh();

    if (typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver(refresh);
    observer.observe(root, {
      attributes: true,
      attributeFilter: [...OBSERVED_ATTRIBUTES],
    });

    return () => observer.disconnect();
  }, []);

  return palette;
}
