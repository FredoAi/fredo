/**
 * #2905 ST-6 / #2909 ST-1 — motion-contract verification suite (product-unit +
 * static pins).
 *
 * Pins the pure motion contract without a drivable OS lever (the live
 * `matchMedia` flip cannot be exercised on this host — G-050/#2870):
 *
 *   - `resolveBackgroundMotion` returns `static` iff the OS preference is reduce
 *     (both legs), and there is NO in-app toggle / second persisted key;
 *   - `isBoundedMotion` validates PER-LAYER envelopes: rejects a duration shorter
 *     than 8 s, a `steps()` easing, an opacity below the floor, an opacity swing
 *     beyond the cap, out-of-range scale/translate/rotate, non-finite endpoints,
 *     and a no-op motion (NF-1) — every layer of every shipped descriptor passes;
 *   - `requiredOverscanPct`/`overscanCovers` are pure and pin the composed
 *     envelope (G-169);
 *   - `buildBackgroundMotionCss` emits ONE generated `@keyframes` block per
 *     animated layer id (`fredo-bg-<layerId>`, 0%/100% from, 50% to) with
 *     transform/opacity only, plus the two declarative static gates;
 *   - `layerBoxStyle` is the ONE shared geometry (overscan iff motion).
 *
 * Constants are IMPORTED from production — never re-derived (ST-6).
 */

import { describe, it, expect } from 'vitest';

import { BACKGROUND_DESCRIPTORS } from '../backgroundRegistry';
import type { BackgroundLayerMotion } from '../backgroundMotion';
import {
  BACKGROUND_MOTION_KINDS,
  MOTION_DURATION_MIN_MS,
  MOTION_GATES_CSS,
  MOTION_LAYERS_MAX,
  MOTION_LAYER_CLASS,
  MOTION_LAYER_OVERSCAN_PCT,
  MOTION_OPACITY_MIN,
  MOTION_OPACITY_SWING_MAX,
  MOTION_ROTATE_MAX_DEG,
  MOTION_SCALE_MAX,
  MOTION_SCALE_MIN,
  MOTION_TRANSLATE_MAX_PCT,
  buildBackgroundMotionCss,
  isBoundedMotion,
  layerAnimationStyle,
  layerBoxStyle,
  overscanCovers,
  requiredOverscanPct,
  resolveBackgroundMotion,
} from '../backgroundMotion';

const BASE_MOTION: BackgroundLayerMotion = {
  kind: 'drift',
  durationMs: MOTION_DURATION_MIN_MS,
  delayMs: 0,
  easing: 'linear',
  translateXPct: { from: -3, to: 3 },
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

describe('#2909 ST-1 — the bounded motion constants', () => {
  it('pins the UNCHANGED floors and the widened per-layer envelope caps', () => {
    expect(MOTION_LAYERS_MAX).toBe(3);
    expect(MOTION_DURATION_MIN_MS).toBe(8000);
    expect(MOTION_OPACITY_MIN).toBe(0.35);
    expect(MOTION_OPACITY_SWING_MAX).toBe(0.45);
    expect(MOTION_TRANSLATE_MAX_PCT).toBe(12);
    expect(MOTION_SCALE_MIN).toBe(0.85);
    expect(MOTION_SCALE_MAX).toBe(1.2);
    expect(MOTION_ROTATE_MAX_DEG).toBe(4);
    expect(MOTION_LAYER_OVERSCAN_PCT).toBe(30);
    expect(BACKGROUND_MOTION_KINDS.length).toBeGreaterThan(0);
  });
});

describe('#2909 ST-1 — isBoundedMotion (per-layer envelopes)', () => {
  it('accepts a minimal valid motion with one non-zero envelope', () => {
    expect(isBoundedMotion(BASE_MOTION)).toBe(true);
    expect(isBoundedMotion({ ...BASE_MOTION, scale: { from: 0.9, to: 1.1 } })).toBe(true);
    expect(isBoundedMotion({ ...BASE_MOTION, opacity: { from: 0.35, to: 0.8 } })).toBe(true);
    expect(isBoundedMotion({ ...BASE_MOTION, rotateDeg: MOTION_ROTATE_MAX_DEG })).toBe(true);
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

  it('rejects an opacity below the floor or a swing beyond the cap', () => {
    expect(
      isBoundedMotion({ ...BASE_MOTION, opacity: { from: MOTION_OPACITY_MIN - 0.01, to: 0.6 } }),
    ).toBe(false);
    // Just beyond the cap is rejected…
    expect(
      isBoundedMotion({ ...BASE_MOTION, opacity: { from: 0.35, to: 0.35 + MOTION_OPACITY_SWING_MAX + 0.05 } }),
    ).toBe(false);
    // …and an envelope exactly AT the cap passes (IEEE-754 epsilon).
    expect(isBoundedMotion({ ...BASE_MOTION, opacity: { from: 0.35, to: 0.8 } })).toBe(true);
  });

  it('rejects out-of-range scale / translate / rotate and non-finite endpoints', () => {
    expect(isBoundedMotion({ ...BASE_MOTION, scale: { from: MOTION_SCALE_MIN - 0.1, to: 1 } })).toBe(
      false,
    );
    expect(isBoundedMotion({ ...BASE_MOTION, scale: { from: 1, to: MOTION_SCALE_MAX + 0.1 } })).toBe(
      false,
    );
    expect(
      isBoundedMotion({
        ...BASE_MOTION,
        translateXPct: { from: -MOTION_TRANSLATE_MAX_PCT - 1, to: 0 },
      }),
    ).toBe(false);
    expect(
      isBoundedMotion({ ...BASE_MOTION, translateYPct: { from: 0, to: MOTION_TRANSLATE_MAX_PCT + 1 } }),
    ).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, rotateDeg: MOTION_ROTATE_MAX_DEG + 1 })).toBe(false);
    expect(isBoundedMotion({ ...BASE_MOTION, translateXPct: { from: Number.NaN, to: 1 } })).toBe(
      false,
    );
  });

  it('rejects a no-op motion with no non-zero amplitude envelope (NF-1)', () => {
    const { translateXPct: _omit, ...noAmplitude } = BASE_MOTION;
    expect(isBoundedMotion(noAmplitude)).toBe(false);
    expect(
      isBoundedMotion({ ...BASE_MOTION, translateXPct: { from: 2, to: 2 }, rotateDeg: 0 }),
    ).toBe(false);
  });
});

describe('#2909 ST-1 — requiredOverscanPct / overscanCovers (G-169)', () => {
  it('derives the composed-envelope overscan and pins the worst declared case', () => {
    const worst: BackgroundLayerMotion = {
      kind: 'sweep',
      durationMs: 26000,
      delayMs: 0,
      easing: 'ease-in-out',
      translateXPct: { from: -7, to: 7 },
      scale: { from: 0.9, to: 1.1 },
    };
    const required = requiredOverscanPct(worst);
    expect(required).toBeGreaterThan(11);
    expect(required).toBeLessThan(12);
    expect(required).toBeLessThanOrEqual(MOTION_LAYER_OVERSCAN_PCT);
    expect(overscanCovers(worst)).toBe(true);
  });

  it('accounts for rotate corner slack and scale shrink', () => {
    const rotate: BackgroundLayerMotion = { ...BASE_MOTION, translateXPct: undefined, rotateDeg: 4 };
    expect(requiredOverscanPct(rotate)).toBeGreaterThan(0);
    const shrink: BackgroundLayerMotion = { ...BASE_MOTION, translateXPct: undefined, scale: { from: 0.85, to: 1 } };
    expect(requiredOverscanPct(shrink)).toBeGreaterThan(0);
  });

  it('is false when an envelope requires more than the automatic overscan', () => {
    const runaway = { ...BASE_MOTION, translateXPct: { from: -30, to: 30 } } as BackgroundLayerMotion;
    expect(overscanCovers(runaway)).toBe(false);
  });

  it('every shipped descriptor layer motion is bounded AND overscan-covered', () => {
    let animated = 0;
    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      expect(descriptor.layers.length).toBeLessThanOrEqual(MOTION_LAYERS_MAX);
      for (const layer of descriptor.layers) {
        if (!layer.motion) continue;
        animated += 1;
        expect(isBoundedMotion(layer.motion), `${descriptor.id}/${layer.id}: bounded`).toBe(true);
        expect(overscanCovers(layer.motion), `${descriptor.id}/${layer.id}: overscan`).toBe(true);
      }
    }
    expect(animated).toBeGreaterThan(0);
  });
});

describe('#2909 ST-1 — generated per-layer @keyframes stylesheet', () => {
  it('emits ONE block per animated layer id (and none for static layers)', () => {
    const css = buildBackgroundMotionCss([
      { id: 'layer-a', motion: { ...BASE_MOTION } },
      { id: 'layer-static' },
      { id: 'layer-b', motion: { ...BASE_MOTION, kind: 'twinkle', translateXPct: undefined, opacity: { from: 0.4, to: 0.8 } } },
    ]);
    expect(css).toContain('@keyframes fredo-bg-layer-a');
    expect(css).toContain('@keyframes fredo-bg-layer-b');
    expect(css).not.toContain('fredo-bg-layer-static');
  });

  it('renders the envelope from at 0%/100% and to at 50% (transform/opacity only)', () => {
    const css = buildBackgroundMotionCss([
      {
        id: 'envelope',
        motion: {
          kind: 'sweep',
          durationMs: 26000,
          delayMs: 0,
          easing: 'ease-in-out',
          translateXPct: { from: -7, to: 7 },
          translateYPct: { from: -4, to: 4 },
        },
      },
    ]);
    expect(css).toContain('0%, 100% { transform: translate3d(-7%, -4%, 0); }');
    expect(css).toContain('50% { transform: translate3d(7%, 4%, 0); }');
    expect(css).not.toMatch(/steps\(/);
    expect(css).not.toMatch(/background-position/);
    expect(css).not.toMatch(/background-size/);
    expect(css).not.toMatch(/url\s*\(/);
    expect(css).not.toMatch(/\bcolor\s*:/);
  });

  it('gives two layers of the same kind INDEPENDENT amplitudes', () => {
    const css = buildBackgroundMotionCss([
      { id: 'small', motion: { ...BASE_MOTION, translateXPct: { from: -2, to: 2 } } },
      { id: 'large', motion: { ...BASE_MOTION, translateXPct: { from: -8, to: 8 } } },
    ]);
    expect(css).toContain('translate3d(-2%, 0%, 0)');
    expect(css).toContain('translate3d(8%, 0%, 0)');
  });

  it('carries both declarative static gates and the shared layer class', () => {
    expect(MOTION_GATES_CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(MOTION_GATES_CSS).toContain('[data-motion="static"]');
    expect(MOTION_GATES_CSS).toContain(`.${MOTION_LAYER_CLASS}`);
    expect(MOTION_GATES_CSS).toMatch(/animation:\s*none\s*!important/);
    expect(buildBackgroundMotionCss([])).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('#2909 ST-1 — layerAnimationStyle binds the LAYER id', () => {
  it('derives the inline animation properties from the layer id + bounded motion', () => {
    const style = layerAnimationStyle({
      id: 'nebula-dust',
      motion: {
        kind: 'twinkle',
        durationMs: 11000,
        delayMs: 3500,
        easing: 'ease-in-out',
        direction: 'alternate',
        opacity: { from: 0.35, to: 0.8 },
      },
    });
    expect(style.animationName).toBe('fredo-bg-nebula-dust');
    expect(style.animationDuration).toBe('11000ms');
    expect(style.animationDelay).toBe('3500ms');
    expect(style.animationTimingFunction).toBe('ease-in-out');
    expect(style.animationDirection).toBe('alternate');
    expect(style.animationIterationCount).toBe('infinite');
  });

  it('defaults the direction to normal when omitted', () => {
    const style = layerAnimationStyle({ id: 'x', motion: { ...BASE_MOTION } });
    expect(style.animationDirection).toBe('normal');
    expect(style.animationName).toBe('fredo-bg-x');
  });
});

describe('#2909 ST-1 — layerBoxStyle (the ONE shared geometry, UX-3)', () => {
  it('overscans iff the layer carries motion, as CSS unit strings', () => {
    expect(layerBoxStyle({})).toEqual({ inset: '0' });
    expect(layerBoxStyle({ motion: { ...BASE_MOTION } })).toEqual({
      inset: `-${MOTION_LAYER_OVERSCAN_PCT}%`,
    });
  });
});
