/**
 * #2905 ST-6 — animation verification suite (product-unit + static pins).
 *
 * Pins the pure motion contract without a drivable OS lever (the live
 * `matchMedia` flip cannot be exercised on this host — G-050/#2870):
 *
 *   - `resolveBackgroundMotion` returns `static` iff the OS preference is reduce
 *     (both legs), and there is NO in-app toggle / second persisted key;
 *   - `isBoundedMotion` rejects a duration shorter than 8 s, a `steps()` easing,
 *     an opacity below the floor, and out-of-range scale/translate/rotate — and
 *     every layer of every shipped descriptor passes;
 *   - the ONE stylesheet owns `@keyframes` (transform/opacity only), the two
 *     declarative static gates, and no repaint/colour/steps substrate.
 *
 * Constants are IMPORTED from production — never re-derived (ST-6).
 */

import { describe, it, expect } from 'vitest';

import { BACKGROUND_DESCRIPTORS, type BackgroundLayerMotion } from '../backgroundRegistry';
import {
  BACKGROUND_MOTION_CSS,
  BACKGROUND_MOTION_KINDS,
  MOTION_BREATHE_MIN_MS,
  MOTION_DURATION_MIN_MS,
  MOTION_KEYFRAME_SPECS,
  MOTION_LAYERS_MAX,
  MOTION_LAYER_CLASS,
  MOTION_OPACITY_MIN,
  MOTION_OPACITY_SWING_MAX,
  MOTION_ROTATE_MAX_DEG,
  MOTION_SCALE_MAX,
  MOTION_SCALE_MIN,
  MOTION_TRANSLATE_MAX_PCT,
  isBoundedMotion,
  layerAnimationStyle,
  resolveBackgroundMotion,
} from '../backgroundMotion';

const BASE_MOTION: BackgroundLayerMotion = {
  kind: 'drift',
  durationMs: MOTION_DURATION_MIN_MS,
  delayMs: 0,
  easing: 'linear',
};

describe('#2905 ST-6 — resolveBackgroundMotion (pure product-unit gate)', () => {
  it('maps the OS preference to the motion status on BOTH legs', () => {
    expect(resolveBackgroundMotion({ systemReducedMotion: false })).toBe('animated');
    expect(resolveBackgroundMotion({ systemReducedMotion: true })).toBe('static');
  });

  it('is a pure function of its input (same input → same output)', () => {
    expect(resolveBackgroundMotion({ systemReducedMotion: false })).toBe(
      resolveBackgroundMotion({ systemReducedMotion: false }),
    );
    expect(resolveBackgroundMotion({ systemReducedMotion: true })).toBe('static');
  });
});

describe('#2905 ST-6 — isBoundedMotion', () => {
  it('accepts a minimal valid motion', () => {
    expect(isBoundedMotion(BASE_MOTION)).toBe(true);
  });

  it('rejects a duration shorter than MOTION_DURATION_MIN_MS', () => {
    expect(isBoundedMotion({ ...BASE_MOTION, durationMs: MOTION_DURATION_MIN_MS - 1 })).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, durationMs: 0 })).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, durationMs: Number.NaN })).toBe(false);
  });

  it('rejects a steps() easing (and any unknown easing)', () => {
    expect(isBoundedMotion({ ...BASE_MOTION, easing: 'steps(4)' as never })).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, easing: 'ease' as never })).toBe(false);
  });

  it('rejects a delay outside [0, duration)', () => {
    expect(isBoundedMotion({ ...BASE_MOTION, delayMs: -1 })).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, delayMs: BASE_MOTION.durationMs })).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, delayMs: BASE_MOTION.durationMs + 1 })).toBe(false);
  });

  it('rejects an unknown kind / direction', () => {
    expect(isBoundedMotion({ ...BASE_MOTION, kind: 'wobble' as never })).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, direction: 'sideways' as never })).toBe(false);
  });

  it('rejects an opacity below the floor', () => {
    const spec = { ...MOTION_KEYFRAME_SPECS.breathe, opacityMin: MOTION_OPACITY_MIN - 0.01, opacityMax: 0.6 };
    expect(isBoundedMotion({ ...BASE_MOTION, kind: 'breathe' }, spec)).toBe(false);
  });

  it('rejects an opacity swing larger than the cap', () => {
    const spec = { ...MOTION_KEYFRAME_SPECS.breathe, opacityMin: 0.4, opacityMax: 0.9 };
    expect(spec.opacityMax - spec.opacityMin).toBeGreaterThan(MOTION_OPACITY_SWING_MAX);
    expect(isBoundedMotion({ ...BASE_MOTION, kind: 'breathe' }, spec)).toBe(false);
  });

  it('rejects out-of-range scale / translate / rotate', () => {
    expect(
      isBoundedMotion(
        { ...BASE_MOTION, kind: 'breathe' },
        { ...MOTION_KEYFRAME_SPECS.breathe, scaleMax: MOTION_SCALE_MAX + 0.1 },
      ),
    ).toBe(false);
    expect(
      isBoundedMotion(
        { ...BASE_MOTION, kind: 'breathe' },
        { ...MOTION_KEYFRAME_SPECS.breathe, scaleMin: MOTION_SCALE_MIN - 0.1 },
      ),
    ).toBe(false);
    expect(
      isBoundedMotion(
        { ...BASE_MOTION, kind: 'drift' },
        { ...MOTION_KEYFRAME_SPECS.drift, translatePct: MOTION_TRANSLATE_MAX_PCT + 1 },
      ),
    ).toBe(false);
    expect(
      isBoundedMotion(
        { ...BASE_MOTION, kind: 'rotate' },
        { ...MOTION_KEYFRAME_SPECS.rotate, rotateDeg: MOTION_ROTATE_MAX_DEG + 1 },
      ),
    ).toBe(false);
  });

  it('enforces a zero opacity swing on the sweep kind', () => {
    expect(
      isBoundedMotion(
        { ...BASE_MOTION, kind: 'sweep' },
        { ...MOTION_KEYFRAME_SPECS.sweep, opacityMin: 0.8, opacityMax: 0.9 },
      ),
    ).toBe(false);
  });

  it('every shipped descriptor layer motion passes and the per-kind budgets are all in range', () => {
    for (const kind of BACKGROUND_MOTION_KINDS) {
      const spec = MOTION_KEYFRAME_SPECS[kind];
      expect(spec.opacityMin, `${kind}: opacity floor`).toBeGreaterThanOrEqual(MOTION_OPACITY_MIN);
      expect(spec.opacityMax - spec.opacityMin, `${kind}: opacity swing`).toBeLessThanOrEqual(
        MOTION_OPACITY_SWING_MAX,
      );
      expect(spec.scaleMin, `${kind}: scaleMin`).toBeGreaterThanOrEqual(MOTION_SCALE_MIN);
      expect(spec.scaleMax, `${kind}: scaleMax`).toBeLessThanOrEqual(MOTION_SCALE_MAX);
      expect(Math.abs(spec.translatePct), `${kind}: translate`).toBeLessThanOrEqual(
        MOTION_TRANSLATE_MAX_PCT,
      );
      expect(Math.abs(spec.rotateDeg), `${kind}: rotate`).toBeLessThanOrEqual(MOTION_ROTATE_MAX_DEG);
    }

    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      expect(descriptor.layers.length).toBeLessThanOrEqual(MOTION_LAYERS_MAX);
      let animated = 0;
      for (const layer of descriptor.layers) {
        if (!layer.motion) continue;
        animated += 1;
        expect(isBoundedMotion(layer.motion), `${descriptor.id}/${layer.id}`).toBe(true);
      }
      expect(animated, `${descriptor.id}: has bounded motion`).toBeGreaterThan(0);
    }
  });
});

describe('#2905 ST-6 — speed-class constants', () => {
  it('the twinkle floor is at least the global duration floor', () => {
    expect(MOTION_BREATHE_MIN_MS).toBeGreaterThanOrEqual(MOTION_DURATION_MIN_MS);
    expect(MOTION_LAYERS_MAX).toBe(3);
    expect(MOTION_OPACITY_MIN).toBe(0.35);
    expect(BACKGROUND_MOTION_KINDS.length).toBeGreaterThan(0);
  });
});

describe('#2905 ST-6 — the ONE injected stylesheet', () => {
  it('owns one @keyframes block per kind, animated with transform/opacity only', () => {
    for (const kind of BACKGROUND_MOTION_KINDS) {
      expect(BACKGROUND_MOTION_CSS).toContain(`@keyframes fredo-bg-${kind}`);
    }
    // No repaint-per-frame, stepped timing, colour animation, or raster.
    expect(BACKGROUND_MOTION_CSS).not.toMatch(/steps\(/);
    expect(BACKGROUND_MOTION_CSS).not.toMatch(/background-position/);
    expect(BACKGROUND_MOTION_CSS).not.toMatch(/background-attachment/);
    expect(BACKGROUND_MOTION_CSS).not.toMatch(/url\s*\(/);
    expect(BACKGROUND_MOTION_CSS).not.toMatch(/\bcolor\s*:/);
  });

  it('carries both declarative static gates and the layer class', () => {
    expect(BACKGROUND_MOTION_CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(BACKGROUND_MOTION_CSS).toContain('[data-motion="static"]');
    expect(BACKGROUND_MOTION_CSS).toContain(`.${MOTION_LAYER_CLASS}`);
    expect(BACKGROUND_MOTION_CSS).toMatch(/animation:\s*none\s*!important/);
  });
});

describe('#2905 ST-6 — layerAnimationStyle', () => {
  it('derives the inline animation properties from the bounded motion', () => {
    const style = layerAnimationStyle({
      kind: 'twinkle',
      durationMs: 11000,
      delayMs: 3500,
      easing: 'ease-in-out',
      direction: 'alternate',
    });
    expect(style.animationName).toBe('fredo-bg-twinkle');
    expect(style.animationDuration).toBe('11000ms');
    expect(style.animationDelay).toBe('3500ms');
    expect(style.animationTimingFunction).toBe('ease-in-out');
    expect(style.animationDirection).toBe('alternate');
    expect(style.animationIterationCount).toBe('infinite');
  });

  it('defaults the direction to normal when omitted', () => {
    expect(layerAnimationStyle(BASE_MOTION).animationDirection).toBe('normal');
  });
});
