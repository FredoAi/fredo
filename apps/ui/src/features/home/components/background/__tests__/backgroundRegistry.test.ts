/**
 * #2899 ST-1 / #2905 ST-5 / #2909 ST-2 — background registry unit pin.
 *
 * Pins the closed id set (`none` + six procedural recipes), the LAYERED
 * descriptor contract (`css` ground + `layers[]` each with one or more token-only
 * gradients and optional bounded motion), the #2909 IDENTITY TABLE (per-layer
 * kind/cadence/envelope, one broad-edge PRIMARY driver per recipe, structured
 * trackable paint), the per-option motion distinctness, the verbatim extraction
 * of the shipped desktop texture into `NONE_BACKGROUND.css`, the lenient
 * never-throwing fallback of `getBackgroundDescriptor`, and the literal-free
 * paint contract (no hex / rgb / hsl literal, no `data:` / `url(` in the registry
 * source OR in any emitted ground/layer; tint alpha ≤45%).
 *
 * Source-scan pattern mirrors
 * `shared/components/companion/__tests__/companion.cursorReducedMotion.test.ts`
 * (vitest cwd = apps/ui; read with `readFileSync(resolve(process.cwd(), …))`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BACKGROUND_DESCRIPTORS,
  NONE_BACKGROUND,
  getBackgroundDescriptor,
  isBackgroundId,
  type BackgroundDescriptor,
  type BackgroundId,
  type BackgroundLayerMotion,
} from '../backgroundRegistry';
import {
  MOTION_DURATION_MIN_MS,
  MOTION_LAYER_OVERSCAN_PCT,
  isBoundedMotion,
  overscanCovers,
} from '../backgroundMotion';

const REGISTRY_PATH = 'src/features/home/components/background/backgroundRegistry.ts';

function readRegistrySource(): string {
  return readFileSync(resolve(process.cwd(), REGISTRY_PATH), 'utf8');
}

/**
 * Strip block + line comments so prose and issue refs (`#2899` — a hex-looking
 * digit run) are exempt; only executable/emitted CSS is scanned.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const ALL: readonly BackgroundDescriptor[] = [NONE_BACKGROUND, ...BACKGROUND_DESCRIPTORS];
const ALL_IDS: readonly BackgroundId[] = ALL.map((descriptor) => descriptor.id);

/** Ground + every layer's paint — the full serialized recipe. */
function serializePaint(descriptor: BackgroundDescriptor): string {
  return JSON.stringify({ css: descriptor.css, layers: descriptor.layers.map((l) => l.css) });
}

/** The layer-box factor implied by the max overscan (a layer percent is 1.6 vp%). */
const LAYER_BOX_FACTOR = 1 + (2 * MOTION_LAYER_OVERSCAN_PCT) / 100;

/** Peak-to-peak translate travel in VIEWPORT percent (envelope is layer-box %). */
function translateViewportPct(motion: BackgroundLayerMotion): number {
  const swing = (envelope?: { from: number; to: number }): number =>
    envelope ? Math.abs(envelope.to - envelope.from) : 0;
  return Math.max(swing(motion.translateXPct), swing(motion.translateYPct)) * LAYER_BOX_FACTOR;
}

/** Relative scale change across the cycle. */
function scaleSwing(motion: BackgroundLayerMotion): number {
  return motion.scale ? Math.abs(motion.scale.to - motion.scale.from) : 0;
}

/**
 * NF-2 primary driver: a broad-edge layer whose translate moves ≥8% of the
 * viewport (or whose scale changes ≥8%) within ≤20 s (the first half-cycle
 * reaches the endpoint, so `durationMs / 2 <= 20000`).
 */
function isPrimaryDriver(motion: BackgroundLayerMotion): boolean {
  if (motion.durationMs / 2 > 20000) return false;
  return translateViewportPct(motion) >= 8 || scaleSwing(motion) >= 0.08;
}

/** The full motion signature (kind/cadence/easing/envelopes) of one recipe. */
function motionSignatures(descriptor: BackgroundDescriptor): string {
  const signatures = descriptor.layers
    .map((layer) => layer.motion)
    .filter((motion): motion is BackgroundLayerMotion => motion !== undefined)
    .map((motion) =>
      [
        motion.kind,
        motion.durationMs,
        motion.delayMs,
        motion.easing,
        motion.direction ?? 'normal',
        JSON.stringify(motion.translateXPct ?? null),
        JSON.stringify(motion.translateYPct ?? null),
        JSON.stringify(motion.opacity ?? null),
        JSON.stringify(motion.scale ?? null),
        motion.rotateDeg ?? null,
      ].join('|'),
    )
    .sort();
  return JSON.stringify(signatures);
}

/** The Architect-bound identity table (#2909 ST-2), pinned per recipe/layer. */
const EXPECTED_IDENTITY: Readonly<
  Record<string, Readonly<Record<string, BackgroundLayerMotion | null>>>
> = {
  aurora: {
    'aurora-curtain-west': {
      kind: 'sweep',
      durationMs: 26000,
      delayMs: 0,
      easing: 'ease-in-out',
      direction: 'normal',
      translateXPct: { from: -7, to: 7 },
      translateYPct: { from: -4, to: 4 },
    },
    'aurora-curtain-east': {
      kind: 'sweep',
      durationMs: 34000,
      delayMs: 7000,
      easing: 'ease-in-out',
      direction: 'normal',
      translateXPct: { from: 6, to: -6 },
      translateYPct: { from: 4, to: -4 },
    },
  },
  nebula: {
    'nebula-cloud': {
      kind: 'breathe',
      durationMs: 24000,
      delayMs: 0,
      easing: 'ease-in-out',
      direction: 'normal',
      scale: { from: 0.9, to: 1.15 },
      opacity: { from: 0.7, to: 1 },
    },
    'nebula-dust': {
      kind: 'twinkle',
      durationMs: 11000,
      delayMs: 0,
      easing: 'ease-in-out',
      direction: 'normal',
      opacity: { from: 0.35, to: 0.8 },
    },
    'nebula-grain': null,
  },
  mesh: {
    'mesh-node-primary': {
      kind: 'drift',
      durationMs: 21000,
      delayMs: 0,
      easing: 'ease-in-out',
      direction: 'normal',
      translateXPct: { from: -6, to: 6 },
      translateYPct: { from: -6, to: 6 },
    },
    'mesh-node-secondary': {
      kind: 'drift',
      durationMs: 29000,
      delayMs: 5000,
      easing: 'ease-in-out',
      direction: 'normal',
      translateXPct: { from: 6, to: -6 },
      translateYPct: { from: -5, to: 5 },
    },
    'mesh-node-info': {
      kind: 'drift',
      durationMs: 37000,
      delayMs: 11000,
      easing: 'ease-in-out',
      direction: 'normal',
      translateXPct: { from: -5, to: 5 },
      translateYPct: { from: 5, to: -5 },
    },
  },
  topography: {
    'topography-contours-a': {
      kind: 'sweep',
      durationMs: 22000,
      delayMs: 0,
      easing: 'linear',
      direction: 'normal',
      translateXPct: { from: -7, to: 7 },
      translateYPct: { from: 0, to: 0 },
    },
    'topography-contours-b': {
      kind: 'sweep',
      durationMs: 31000,
      delayMs: 4000,
      easing: 'linear',
      direction: 'normal',
      translateXPct: { from: 7, to: -7 },
      translateYPct: { from: 0, to: 0 },
    },
  },
  constellation: {
    'constellation-bloom': {
      kind: 'drift',
      durationMs: 28000,
      delayMs: 0,
      easing: 'linear',
      direction: 'normal',
      translateXPct: { from: -5, to: 5 },
      translateYPct: { from: 3, to: -3 },
    },
    'constellation-stars-far': {
      kind: 'twinkle',
      durationMs: 9000,
      delayMs: 0,
      easing: 'ease-in-out',
      direction: 'normal',
      opacity: { from: 0.35, to: 0.8 },
    },
    'constellation-stars-near': {
      kind: 'twinkle',
      durationMs: 13000,
      delayMs: 3000,
      easing: 'ease-in-out',
      direction: 'normal',
      opacity: { from: 0.35, to: 0.8 },
    },
  },
  halo: {
    'halo-glow': {
      kind: 'breathe',
      durationMs: 16000,
      delayMs: 0,
      easing: 'ease-in-out',
      direction: 'normal',
      scale: { from: 0.92, to: 1.15 },
      opacity: { from: 0.7, to: 1 },
    },
  },
};

describe('#2899 ST-1 / #2905 ST-5 / #2909 ST-2 — background registry', () => {
  it('defines the closed 7-id set: none + six procedural recipes', () => {
    expect(ALL_IDS).toEqual([
      'none',
      'aurora',
      'nebula',
      'mesh',
      'topography',
      'constellation',
      'halo',
    ]);
    expect(new Set(ALL_IDS).size).toBe(7);
    expect(BACKGROUND_DESCRIPTORS).toHaveLength(6);
  });

  it('gives every option a non-empty distinct label', () => {
    const labels = ALL.map((descriptor) => descriptor.label);
    for (const label of labels) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(7);
    expect(NONE_BACKGROUND.label).toBe('None');
  });

  it('resolves every one of the 7 ids back to its descriptor', () => {
    for (const descriptor of ALL) {
      expect(getBackgroundDescriptor(descriptor.id)).toBe(descriptor);
    }
  });

  it('isBackgroundId accepts exactly the 7 known ids and rejects anything else', () => {
    for (const id of ALL_IDS) {
      expect(isBackgroundId(id)).toBe(true);
    }
    for (const candidate of ['', 'banana', 'Aurora', 'AURORA', 'none ', ' null', 'mesh\u0000']) {
      expect(isBackgroundId(candidate)).toBe(false);
    }
  });

  it('normalizes unknown / empty / stale / removed ids to none and never throws', () => {
    for (const raw of [
      '',
      'banana',
      'Aurora',
      'AURORA',
      '__nope__',
      'removed-id',
      'null',
      'none ',
      'topography ',
    ]) {
      expect(() => getBackgroundDescriptor(raw)).not.toThrow();
      expect(getBackgroundDescriptor(raw)).toBe(NONE_BACKGROUND);
      expect(getBackgroundDescriptor(raw).id).toBe('none');
    }
  });

  it('exposes a layered descriptor contract: ground css + layers[] (none has none)', () => {
    expect(NONE_BACKGROUND.layers).toEqual([]);
    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      expect(Array.isArray(descriptor.layers)).toBe(true);
      expect(descriptor.layers.length).toBeGreaterThanOrEqual(1);
      expect(descriptor.layers.length).toBeLessThanOrEqual(3);
      for (const layer of descriptor.layers) {
        expect(typeof layer.id).toBe('string');
        expect(layer.id.length).toBeGreaterThan(0);
        expect(layer.css).toBeTypeOf('object');
        expect(Object.keys(layer.css).length).toBeGreaterThan(0);
      }
      const ids = descriptor.layers.map((layer) => layer.id);
      expect(new Set(ids).size, `${descriptor.id}: unique layer ids`).toBe(ids.length);
    }
  });

  it('binds the identity table exactly (kind/cadence/easing/envelopes per layer)', () => {
    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      const expected = EXPECTED_IDENTITY[descriptor.id];
      expect(expected, `${descriptor.id}: identity table entry`).toBeDefined();
      expect(
        descriptor.layers.map((layer) => layer.id),
        `${descriptor.id}: declared layer ids`,
      ).toEqual(Object.keys(expected));
      for (const layer of descriptor.layers) {
        expect(layer.motion ?? null, `${descriptor.id}/${layer.id}`).toEqual(expected[layer.id]);
      }
    }
  });

  it('gives every recipe ≥1 broad-edge PRIMARY driver meeting NF-2', () => {
    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      const primaries = descriptor.layers.filter(
        (layer) => layer.motion !== undefined && isPrimaryDriver(layer.motion),
      );
      expect(primaries.length, `${descriptor.id}: primary driver`).toBeGreaterThan(0);
      for (const primary of primaries) {
        const paint = String(primary.css.backgroundImage ?? '');
        expect(paint, `${descriptor.id}/${primary.id}: structured paint`).toMatch(
          /repeating-linear-gradient|radial-gradient/,
        );
      }
    }
  });

  it('gives every recipe a structured trackable paint (band/line/ring/dot)', () => {
    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      const structured = descriptor.layers.filter((layer) =>
        /repeating-linear-gradient|radial-gradient/.test(String(layer.css.backgroundImage ?? '')),
      );
      expect(structured.length, `${descriptor.id}: structured layer`).toBeGreaterThan(0);
    }
  });

  it('the 6 procedural descriptors are pairwise distinct (ground + layers + motion identity)', () => {
    const paints = BACKGROUND_DESCRIPTORS.map(serializePaint);
    expect(new Set(paints).size).toBe(6);
    for (const paint of paints) {
      expect(paint).not.toBe(serializePaint(NONE_BACKGROUND));
    }

    const signatures = BACKGROUND_DESCRIPTORS.map(motionSignatures);
    for (const signature of signatures) {
      expect(JSON.parse(signature).length).toBeGreaterThan(0);
    }
    expect(new Set(signatures).size).toBe(6);
  });

  it('every layer motion is bounded AND overscan-covered (duration >= 8000, valid easing/delay/direction)', () => {
    let motionCount = 0;
    for (const descriptor of BACKGROUND_DESCRIPTORS) {
      for (const layer of descriptor.layers) {
        if (!layer.motion) continue;
        motionCount += 1;
        const motion = layer.motion;
        expect(motion.durationMs, `${layer.id}: duration`).toBeGreaterThanOrEqual(
          MOTION_DURATION_MIN_MS,
        );
        expect(motion.delayMs, `${layer.id}: delay >= 0`).toBeGreaterThanOrEqual(0);
        expect(motion.delayMs, `${layer.id}: delay < duration`).toBeLessThan(motion.durationMs);
        expect(['linear', 'ease-in-out']).toContain(motion.easing);
        if (motion.direction !== undefined) {
          expect(['normal', 'alternate', 'reverse']).toContain(motion.direction);
        }
        expect(isBoundedMotion(motion), `${layer.id}: isBoundedMotion`).toBe(true);
        expect(overscanCovers(motion), `${layer.id}: overscanCovers`).toBe(true);
      }
    }
    expect(motionCount).toBeGreaterThan(0);
  });

  it('NONE_BACKGROUND.css deep-equals the shipped DESKTOP_TEXTURE_CSS values', () => {
    expect(NONE_BACKGROUND.id).toBe('none');
    expect(NONE_BACKGROUND.css).toEqual({
      backgroundColor: 'var(--card-bg)',
      backgroundImage: [
        'linear-gradient(to right, color-mix(in srgb, var(--border-color) 12%, transparent) 1px, transparent 1px)',
        'linear-gradient(to bottom, color-mix(in srgb, var(--border-color) 12%, transparent) 1px, transparent 1px)',
      ].join(', '),
      backgroundSize: '28px 28px',
    });
    expect(NONE_BACKGROUND.layers).toEqual([]);
  });

  it('registry source + emitted paint (grounds + every layer) contain no hex/rgb/hsl literal and no data:/url( reference', () => {
    const code = stripComments(readRegistrySource());
    const emitted = JSON.stringify(
      ALL.map((descriptor) => ({
        css: descriptor.css,
        layers: descriptor.layers.map((layer) => layer.css),
      })),
    );

    for (const subject of [code, emitted]) {
      expect(subject).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(subject).not.toMatch(/\brgba?\s*\(/);
      expect(subject).not.toMatch(/\bhsla?\s*\(/);
      expect(subject).not.toMatch(/url\s*\(/);
      expect(subject).not.toMatch(/data:/);
    }

    // The emitted paint *must* still use the live theme surface, not a literal.
    expect(emitted).toContain('color-mix(in srgb, var(--');
    expect(emitted).toContain('var(--card-bg)');
  });

  it('never alpha-appends digits onto a var() reference (invalid var(--x)NN form)', () => {
    const code = stripComments(readRegistrySource());
    expect(code).not.toMatch(/var\(--[a-z0-9-]+\)\d/);
    const emitted = JSON.stringify(
      ALL.flatMap((descriptor) => [
        descriptor.css,
        ...descriptor.layers.map((layer) => layer.css),
      ]),
    );
    expect(emitted).not.toMatch(/var\(--[a-z0-9-]+\)\d/);
  });

  it('keeps every layer tint alpha ≤45% over the opaque token ground', () => {
    const emitted = JSON.stringify(
      BACKGROUND_DESCRIPTORS.flatMap((descriptor) =>
        descriptor.layers.map((layer) => layer.css),
      ),
    );
    const alphas = Array.from(
      emitted.matchAll(/color-mix\(in srgb, var\(--[a-z-]+\) (\d+(?:\.\d+)?)%/g),
      (match) => Number(match[1]),
    );
    expect(alphas.length).toBeGreaterThan(0);
    for (const alpha of alphas) {
      expect(alpha, 'layer tint alpha').toBeLessThanOrEqual(45);
    }
  });
});
