/**
 * #2899 ST-1 / #2905 ST-5 — background registry unit pin.
 *
 * Pins the closed id set (`none` + six procedural recipes), the LAYERED
 * descriptor contract (`css` ground + `layers[]` each with one gradient and
 * optional bounded motion), the per-option motion identity distinctness, the
 * verbatim extraction of the shipped desktop texture into `NONE_BACKGROUND.css`,
 * the lenient never-throwing fallback of `getBackgroundDescriptor`, and the
 * literal-free paint contract (no hex / rgb / hsl literal, no `data:` / `url(` in
 * the registry source OR in any emitted ground/layer).
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
import { MOTION_DURATION_MIN_MS, isBoundedMotion } from '../backgroundMotion';

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

/** The per-option animation signature set (kind/duration/delay/easing/direction). */
function motionSignatures(descriptor: BackgroundDescriptor): string {
  const signatures = descriptor.layers
    .map((layer) => layer.motion)
    .filter((motion): motion is BackgroundLayerMotion => motion !== undefined)
    .map((motion) =>
      [motion.kind, motion.durationMs, motion.delayMs, motion.easing, motion.direction ?? 'normal'].join(
        '|',
      ),
    )
    .sort();
  return JSON.stringify(signatures);
}

describe('#2899 ST-1 / #2905 ST-5 — background registry', () => {
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

  it('every layer motion is bounded (duration >= 8000, valid easing/delay/direction)', () => {
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
});
