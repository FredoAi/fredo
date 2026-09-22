import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildInteriorPathD,
  expandFredoRects,
  FREDO_AVATAR_INTERIOR_RECTS,
  FREDO_AVATAR_SOURCE_RECTS,
} from '../fredoAvatarGeometry';

/**
 * #2926 ST-1 — parity + legibility guard for the committed icon source masters.
 *
 * The shipped OS icon set is rasterised from exactly TWO committed SVG masters
 * (`apps/tauri/src-tauri/icons/fredo-icon-large.svg` for target sizes >= 30 px,
 * `fredo-icon-small.svg` for 16/24 px). Nothing else is an input. This suite is
 * the drift guard:
 *
 *  - the large master is PROVABLY the frozen canonical geometry — its 58 `<rect>`
 *    values equal `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)` as a multiset and
 *    its single interior `<path d>` equals `buildInteriorPathD(expandFredoRects(
 *    FREDO_AVATAR_INTERIOR_RECTS))`, so a geometry change that the icon was not
 *    re-derived from fails CI;
 *  - the large transform is ONE uniform `scale(S)` about the figure bbox inside
 *    the 86% content box — `scale(sx, sy)` is forbidden (no-stretch, R-3);
 *  - the small master (a deliberate 16-unit grid-aligned head-only variant, not a
 *    downscale) keeps every feature on the integer grid at >= 1 unit, is mirror
 *    symmetric about x = 8, and its rim encloses the interior on all four sides so
 *    neither the tile nor the interior can leak through a step (R-3 legibility);
 *  - both masters bake only the three explicitly scoped palette literals and carry
 *    no effects (no gradient/filter/shadow/bevel).
 *
 * Files are read with `readFileSync(resolve(process.cwd(), ...))` — vitest runs
 * with cwd = `apps/ui`, matching the established convention in this workspace
 * (`import.meta.url` is not a file scheme under this workspace setup).
 */

const ICONS_DIR = resolve(process.cwd(), '../tauri/src-tauri/icons');
const readIcon = (name: string): string => readFileSync(resolve(ICONS_DIR, name), 'utf8');

const LARGE = readIcon('fredo-icon-large.svg');
const SMALL = readIcon('fredo-icon-small.svg');

/** The baked palette — the explicit, narrow static-raster token-rule exception. */
const BAKED_PALETTE = ['#0c1117', '#00d1d1', '#0a373c'];

const LARGE_CANVAS = 1024;
const CONTENT_BOX_RATIO = 0.86;
/** Small master content box: 14 x 12 units centred in the 16 x 16 canvas. */
const SMALL_CONTENT = { x: 1, y: 2, width: 14, height: 12 };

interface SvgRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
  part: string | null;
  rx: string | null;
}

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function parseRects(svg: string): SvgRect[] {
  const rects: SvgRect[] = [];
  const re = /<rect\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(svg)) !== null) {
    const attrs = match[1];
    rects.push({
      x: Number(attr(attrs, 'x')),
      y: Number(attr(attrs, 'y')),
      width: Number(attr(attrs, 'width')),
      height: Number(attr(attrs, 'height')),
      fill: attr(attrs, 'fill'),
      part: attr(attrs, 'data-part'),
      rx: attr(attrs, 'rx'),
    });
  }
  return rects;
}

function fillLiterals(svg: string): string[] {
  const out: string[] = [];
  const re = /\bfill="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(svg)) !== null) out.push(match[1].toLowerCase());
  return out;
}

const rectKey = (r: { x: number; y: number; width: number; height: number }): string =>
  `${r.x},${r.y},${r.width},${r.height}`;

function multisetOf(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function largeFigureGroup(svg: string): string {
  const match = svg.match(/<g\b[^>]*\bdata-part="figure"[^>]*>([\s\S]*?)<\/g>/);
  if (!match) throw new Error('fredo-icon-large.svg: <g data-part="figure"> not found');
  return match[1];
}

function largeFigureTransform(svg: string): string {
  const match = svg.match(/<g\b[^>]*\bdata-part="figure"[^>]*\btransform="([^"]*)"/);
  if (!match) throw new Error('fredo-icon-large.svg: figure transform not found');
  return match[1];
}

function assertPaletteOnly(svg: string): void {
  for (const literal of fillLiterals(svg)) {
    expect(BAKED_PALETTE).toContain(literal);
  }
}

function assertNoEffects(svg: string): void {
  for (const forbidden of [
    '<linearGradient',
    '<radialGradient',
    '<filter',
    'filter=',
    'drop-shadow',
    'feGaussianBlur',
    'opacity=',
  ]) {
    expect(svg).not.toContain(forbidden);
  }
}

describe('#2926 icon source masters — large master is the frozen canonical geometry', () => {
  it('declares the 1024 square canvas with crisp edges', () => {
    expect(LARGE).toContain('viewBox="0 0 1024 1024"');
    expect(LARGE).toContain('width="1024"');
    expect(LARGE).toContain('height="1024"');
    expect(LARGE).toContain('shape-rendering="crispEdges"');
  });

  it('carries the full-bleed rounded tile at 12.5% canvas radius', () => {
    const tiles = parseRects(LARGE).filter((r) => r.part === 'tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ x: 0, y: 0, width: 1024, height: 1024, rx: '128', fill: '#0c1117' });
    // The tile is the only full-canvas rect and the only one outside the figure.
    const fullCanvas = parseRects(LARGE).filter((r) => r.width === 1024 && r.height === 1024);
    expect(fullCanvas).toHaveLength(1);
  });

  it('has exactly one figure group whose 58 rects equal expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)', () => {
    expect((LARGE.match(/<g\b/g) ?? []).length).toBe(1);
    const group = largeFigureGroup(LARGE);
    const expected = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
    expect(expected).toHaveLength(58);

    const actual = parseRects(group);
    expect(actual).toHaveLength(58);
    for (const rect of actual) {
      expect(Number.isInteger(rect.x)).toBe(true);
      expect(Number.isInteger(rect.y)).toBe(true);
      expect(rect.fill).toBe('#00D1D1');
    }
    expect(multisetOf(actual.map(rectKey))).toEqual(multisetOf(expected.map(rectKey)));
  });

  it('has exactly one interior <path> equal to buildInteriorPathD(expandFredoRects(FREDO_AVATAR_INTERIOR_RECTS))', () => {
    const group = largeFigureGroup(LARGE);
    const paths = [...group.matchAll(/<path\b([^>]*?)\/?>/g)];
    expect(paths).toHaveLength(1);
    const expectedD = buildInteriorPathD(expandFredoRects(FREDO_AVATAR_INTERIOR_RECTS));
    expect(attr(paths[0][1], 'd')).toBe(expectedD);
    expect(attr(paths[0][1], 'fill')).toBe('#0A373C');
  });

  it('uses ONE uniform scale about the figure bbox inside the 86% content box (no stretch)', () => {
    const transform = largeFigureTransform(LARGE);
    // Exactly `translate(<tx> <ty>) scale(<s>)` — a two-argument scale() is forbidden.
    const match = transform.match(/^translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)$/);
    expect(match).not.toBeNull();
    if (!match) return;

    const rects = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
    const bbox = {
      x: Math.min(...rects.map((r) => r.x)),
      y: Math.min(...rects.map((r) => r.y)),
      width: Math.max(...rects.map((r) => r.x + r.width)) - Math.min(...rects.map((r) => r.x)),
      height: Math.max(...rects.map((r) => r.y + r.height)) - Math.min(...rects.map((r) => r.y)),
    };
    expect(bbox).toEqual({ x: 87, y: 67, width: 840, height: 1167 });

    const expectedScale = (CONTENT_BOX_RATIO * LARGE_CANVAS) / Math.max(bbox.width, bbox.height);
    const expectedTx = LARGE_CANVAS / 2 - (bbox.x + bbox.width / 2) * expectedScale;
    const expectedTy = LARGE_CANVAS / 2 - (bbox.y + bbox.height / 2) * expectedScale;

    expect(Math.abs(Number(match[3]) - expectedScale)).toBeLessThan(1e-5);
    expect(Math.abs(Number(match[1]) - expectedTx)).toBeLessThan(1e-5);
    expect(Math.abs(Number(match[2]) - expectedTy)).toBeLessThan(1e-5);
  });

  it('bakes only the scoped palette and carries no effects', () => {
    assertPaletteOnly(LARGE);
    assertNoEffects(LARGE);
  });
});

describe('#2926 icon source masters — small master legibility on the 16-unit grid', () => {
  it('declares the 16-unit square canvas with crisp edges', () => {
    expect(SMALL).toContain('viewBox="0 0 16 16"');
    expect(SMALL).toContain('width="16"');
    expect(SMALL).toContain('height="16"');
    expect(SMALL).toContain('shape-rendering="crispEdges"');
  });

  it('places every rect on the integer grid with every feature >= 1 unit', () => {
    const rects = parseRects(SMALL);
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      for (const value of [rect.x, rect.y, rect.width, rect.height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(rect.width).toBeGreaterThanOrEqual(1);
      expect(rect.height).toBeGreaterThanOrEqual(1);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(16);
      expect(rect.y + rect.height).toBeLessThanOrEqual(16);
    }
  });

  it('uses the tile as the only full-canvas rect', () => {
    const rects = parseRects(SMALL);
    const fullCanvas = rects.filter((r) => r.width === 16 && r.height === 16);
    expect(fullCanvas).toHaveLength(1);
    expect(fullCanvas[0]).toMatchObject({ x: 0, y: 0, rx: '2', fill: '#0c1117', part: 'tile' });
  });

  it('keeps the head-only silhouette inside the 14 x 12-unit content box', () => {
    const head = parseRects(SMALL).filter((r) => r.part !== 'tile');
    const minX = Math.min(...head.map((r) => r.x));
    const minY = Math.min(...head.map((r) => r.y));
    const maxX = Math.max(...head.map((r) => r.x + r.width));
    const maxY = Math.max(...head.map((r) => r.y + r.height));
    expect(minX).toBeGreaterThanOrEqual(SMALL_CONTENT.x);
    expect(minY).toBeGreaterThanOrEqual(SMALL_CONTENT.y);
    expect(maxX).toBeLessThanOrEqual(SMALL_CONTENT.x + SMALL_CONTENT.width);
    expect(maxY).toBeLessThanOrEqual(SMALL_CONTENT.y + SMALL_CONTENT.height);
    // The deliberate head-only variant must actually use the box it was given.
    expect(maxX - minX).toBeGreaterThanOrEqual(12);
    expect(maxY - minY).toBeGreaterThanOrEqual(10);
  });

  it('draws two eyes that are mirror-symmetric about x = 8 in the upper half', () => {
    const eyes = parseRects(SMALL).filter((r) => r.part === 'eye');
    expect(eyes).toHaveLength(2);
    const [left, right] = [...eyes].sort((a, b) => a.x - b.x);
    expect(left.width).toBe(1);
    expect(left.height).toBe(2);
    expect(16 - left.x - left.width).toBe(right.x);
    expect(right.y).toBe(left.y);
    expect(right.fill).toBe('#00D1D1');
    // Both eyes sit in the upper half of the canvas (centre y < 8).
    expect(left.y + left.height / 2).toBeLessThan(8);
    // A legible gap stays between them.
    expect(right.x - (left.x + left.width)).toBeGreaterThanOrEqual(1);
  });

  it('encloses the interior with rim on all four sides (nothing leaks through a step)', () => {
    const grid = new Array<string>(16 * 16).fill('empty');
    for (const rect of parseRects(SMALL)) {
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) {
          grid[y * 16 + x] = rect.part ?? 'unknown';
        }
      }
    }
    const neighbours: ReadonlyArray<readonly [number, number]> = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const part = grid[y * 16 + x];
        if (part !== 'interior' && part !== 'eye') continue;
        for (const [dx, dy] of neighbours) {
          const nx = x + dx;
          const ny = y + dy;
          expect(nx >= 0 && nx < 16 && ny >= 0 && ny < 16).toBe(true);
          expect(grid[ny * 16 + nx]).not.toBe('tile');
        }
      }
    }
  });

  it('bakes only the scoped palette and carries no effects', () => {
    assertPaletteOnly(SMALL);
    assertNoEffects(SMALL);
  });
});
