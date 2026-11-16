import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildInteriorPathD,
  expandFredoRects,
  FREDO_AVATAR_INTERIOR_RECTS,
  FREDO_AVATAR_SOURCE_RECTS,
} from '../fredoAvatarGeometry';

/**
 * #2926 ST-1 / #2930 ST-4 — parity + legibility guard for the committed icon source.
 *
 * The shipped OS icon set is rasterised from exactly ONE committed SVG source
 * (`apps/tauri/src-tauri/icons/fredo-icon-large.svg` — the full bust) for every
 * target size, including the 16 px and 24 px ICO/ICNS frames. Nothing else is an
 * input. This suite is the drift guard:
 *
 *  - the source is PROVABLY the frozen canonical geometry — its 58 `<rect>`
 *    values equal `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)` as a multiset and
 *    its single interior `<path d>` equals `buildInteriorPathD(expandFredoRects(
 *    FREDO_AVATAR_INTERIOR_RECTS))`, so a geometry change that the icon was not
 *    re-derived from fails CI;
 *  - the transform is ONE uniform `scale(S)` about the figure bbox inside the
 *    86% content box — `scale(sx, sy)` is forbidden (no-stretch, R-3);
 *  - the source bakes only the three explicitly scoped palette literals and
 *    carries no effects (no gradient/filter/shadow/bevel);
 *  - the retired head-only master is gone and the generator selects no second
 *    source (the single-master guards below).
 *
 * Files are read with `readFileSync(resolve(process.cwd(), ...))` — vitest runs
 * with cwd = `apps/ui`, matching the established convention in this workspace
 * (`import.meta.url` is not a file scheme under this workspace setup).
 */

const ICONS_DIR = resolve(process.cwd(), '../tauri/src-tauri/icons');
const readIcon = (name: string): string => readFileSync(resolve(ICONS_DIR, name), 'utf8');
const GENERATOR_SOURCE = readFileSync(
  resolve(process.cwd(), '../../scripts/generate-app-icons.mjs'),
  'utf8',
);

const LARGE = readIcon('fredo-icon-large.svg');

/** The baked palette — the explicit, narrow static-raster token-rule exception. */
const BAKED_PALETTE = ['#0c1117', '#00d1d1', '#0a373c'];

const LARGE_CANVAS = 1024;
const CONTENT_BOX_RATIO = 0.86;

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

describe('#2930 icon source — the one master is the frozen canonical geometry', () => {
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

describe('#2930 icon source — exactly one master drives every artifact', () => {
  it('does not ship the retired head-only master', () => {
    expect(existsSync(resolve(ICONS_DIR, 'fredo-icon-small.svg'))).toBe(false);
  });

  it('generator selects no second source', () => {
    expect(GENERATOR_SOURCE).not.toContain('SMALL_MASTER');
    expect(GENERATOR_SOURCE).not.toMatch(/master\s*:\s*'small'/);
    expect(GENERATOR_SOURCE).not.toMatch(/\bmaster\s*:/);
  });

  it('generator derives every target from the one large master', () => {
    expect(GENERATOR_SOURCE).toContain('fredo-icon-large.svg');
  });
});
