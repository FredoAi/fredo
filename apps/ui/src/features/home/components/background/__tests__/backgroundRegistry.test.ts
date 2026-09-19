/**
 * #2899 ST-1 — background registry unit pin.
 *
 * Pins the closed id set (`none` + six procedural recipes), the descriptor
 * contract, the verbatim extraction of the shipped `DESKTOP_TEXTURE_CSS` into
 * `NONE_BACKGROUND.css`, the lenient never-throwing fallback of
 * `getBackgroundDescriptor`, and the literal-free paint contract (no hex /
 * rgb / hsl literal, no `data:` / `url(` in the registry source).
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
} from '../backgroundRegistry';

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

describe('#2899 ST-1 — background registry', () => {
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

  it('the 6 procedural descriptors are pairwise distinct (serialized css)', () => {
    const serialized = BACKGROUND_DESCRIPTORS.map((descriptor) => JSON.stringify(descriptor.css));
    expect(new Set(serialized).size).toBe(6);
    // `none` must not collide with any procedural recipe either.
    for (const css of serialized) {
      expect(css).not.toBe(JSON.stringify(NONE_BACKGROUND.css));
    }
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

  it('registry source + emitted paint contain no hex/rgb/hsl literal and no data:/url( reference', () => {
    const code = stripComments(readRegistrySource());
    const emitted = JSON.stringify(ALL.map((descriptor) => descriptor.css));

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
});
