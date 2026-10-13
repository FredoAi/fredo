/**
 * Spec #3033 ST-1 — shared WCAG contrast arithmetic for the contrast gate.
 *
 * Single-sourced from the #2946 ST-11 focus suite
 * (`app/theme/__tests__/globalFocusVisible.test.ts:62-109`): the focus suite now
 * imports these helpers and the gate's matrix/evaluate modules consume the same
 * implementation, so there is exactly ONE WCAG arithmetic home (never a copy).
 *
 * Pure and deterministic — no `Date`, random, browser, DOM or filesystem access.
 * Every function is a total function of its arguments.
 */

/** An 8-bit-per-channel sRGB colour. */
export type Rgb = [number, number, number];

/**
 * Parse a CSS `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` hex or `rgb()`/`rgba()`
 * colour into 0-255 channels. Returns `null` when the value is not a colour this
 * gate can reason about (named colours, `color-mix()`, `var()` references, …).
 */
export function parseColor(color: string): Rgb | null {
  const value = color.trim().toLowerCase();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const rrggbb =
      hex.length === 3 || hex.length === 4
        ? hex.slice(0, 3).split('').map((c) => c + c).join('')
        : hex.slice(0, 6);
    if (rrggbb.length !== 6) return null;
    return [
      parseInt(rrggbb.slice(0, 2), 16),
      parseInt(rrggbb.slice(2, 4), 16),
      parseInt(rrggbb.slice(4, 6), 16),
    ];
  }
  const m = value.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((c) => !Number.isFinite(c))) return null;
  return [parts[0], parts[1], parts[2]];
}

/** sRGB gamma-decoded channel (WCAG 2.x definition). */
function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `color-mix(in srgb, first p%, second q%)` over opaque colours (weights sum to 1). */
export function mixSrgb(first: Rgb, second: Rgb, p: number, q: number): Rgb {
  return [
    Math.round(first[0] * p + second[0] * q),
    Math.round(first[1] * p + second[1] * q),
    Math.round(first[2] * p + second[2] * q),
  ];
}

/**
 * Alpha-composite `fg` over `bg` at `alpha` — the per-channel encoded-sRGB
 * source-over blend CSS `opacity: alpha` produces (and the opaque equivalent of
 * `color-mix(in srgb, <color> alpha%, transparent)` painted over `bg`).
 *
 * This is the ONLY way the gate evaluates an opacity-derived control state: the
 * rendered pair is `composite(fg, surface, α)` vs `composite(bg, surface, α)`,
 * never a token read. Rounds to 0-255.
 */
export function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

/** Round to 2 decimal places (the reported contrast-ratio precision). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** WCAG AA absolute floor for body text. */
export const BODY_FLOOR = 4.5;
/** WCAG AA absolute floor for large text, UI components, borders and focus indicators. */
export const UI_FLOOR = 3;
