import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * #2926 ST-1 / #2930 ST-4 — parity + legibility guard for the committed icon source.
 * #3210 ST-7 — RE-POINTED (not deleted) at the 3D character cut-over.
 *
 * The shipped OS icon set is rasterised from exactly ONE committed SVG source
 * (`apps/tauri/src-tauri/icons/fredo-icon-large.svg` — the flat bust) for every
 * target size, including the 16 px and 24 px ICO/ICNS frames. Nothing else is an
 * input.
 *
 * Until #3210 this guard proved the source was the frozen canonical geometry by
 * importing `fredoAvatarGeometry` and comparing against `expandFredoRects` /
 * `buildInteriorPathD`. That module is DELETED with the SVG avatar render path,
 * so the same invariant is now pinned against the committed SVG ITSELF:
 *
 *  - one figure group carrying exactly 58 integer `<rect>` entries;
 *  - exactly one interior `<path>` whose `d` holds 17 closed bands (the frozen
 *    interior fill), filled with the baked interior token literal;
 *  - the single uniform `translate(tx ty) scale(s)` transform, recomputed from
 *    the FROZEN body bbox `87, 67, 840, 1167` (the literal the deleted rect table
 *    produced) inside the 86% content box — `scale(sx, sy)` is forbidden;
 *  - the baked palette only, and no effects (no gradient/filter/shadow/bevel);
 *  - a SHA-256 pin: the icon is a BYTE-IDENTICAL artifact, so a geometry or art
 *    drift can never ship silently (and the cut-over must not move it);
 *  - the retired head-only master stays gone and the generator selects no second
 *    source, and writes nothing under `shared/components/fredo-avatar/`.
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

/** The frozen body bbox the deleted `FREDO_AVATAR_SOURCE_RECTS` expansion produced. */
const FIGURE_BBOX = { x: 87, y: 67, width: 840, height: 1167 } as const;

/** The frozen figure rect count (the 31 authored calls → 58 with mirrors). */
const FIGURE_RECT_COUNT = 58;

/** The frozen interior fill: 17 closed bands (head bands + whole-body bands). */
const INTERIOR_BAND_COUNT = 17;

/** The first interior band, verbatim — the fill's own identity check. */
const FIRST_INTERIOR_BAND = 'M 364 106 h 286 v 43 h -286 Z';

/**
 * SHA-256 of `fredo-icon-large.svg` at the #3210 cut-over, computed over the
 * LF-NORMALISED text. The 3D avatar landing must not move the shipped icon: this
 * is the byte/content-identity pin. (The repo declares no `.gitattributes` EOL
 * rule, so a Windows checkout materialises CRLF while CI materialises LF;
 * normalising keeps ONE digest valid on every checkout — a raw-bytes digest would
 * pass here and fail on CI. Geometry drift is additionally caught by the rect /
 * bbox / path / transform assertions above, which are EOL-agnostic.)
 */
const ICON_SHA256 = 'fbaf56a783618cd9d94608596db8a48f19b1937b2a4bd815bdf30017062a1e1d';

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

describe('#3210 icon source — the one master is the frozen canonical geometry', () => {
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

  it('has exactly one figure group carrying the frozen 58 rects', () => {
    expect((LARGE.match(/<g\b/g) ?? []).length).toBe(1);
    const group = largeFigureGroup(LARGE);
    const actual = parseRects(group);

    expect(actual).toHaveLength(FIGURE_RECT_COUNT);
    for (const rect of actual) {
      expect(Number.isInteger(rect.x)).toBe(true);
      expect(Number.isInteger(rect.y)).toBe(true);
      expect(rect.fill).toBe('#00D1D1');
    }

    // The frozen body bbox (the literal the deleted rect table produced) — the
    // union of the 58 rect entries must still be exactly this box.
    const bbox = {
      x: Math.min(...actual.map((r) => r.x)),
      y: Math.min(...actual.map((r) => r.y)),
      width: Math.max(...actual.map((r) => r.x + r.width)) - Math.min(...actual.map((r) => r.x)),
      height: Math.max(...actual.map((r) => r.y + r.height)) - Math.min(...actual.map((r) => r.y)),
    };
    expect(bbox).toEqual({ ...FIGURE_BBOX });
  });

  it('has exactly one interior <path> with the frozen 17 closed bands', () => {
    const group = largeFigureGroup(LARGE);
    const paths = [...group.matchAll(/<path\b([^>]*?)\/?>/g)];
    expect(paths).toHaveLength(1);

    const d = attr(paths[0][1], 'd');
    expect(d).not.toBeNull();
    expect(d).toContain(FIRST_INTERIOR_BAND);
    // One `M` per closed band — the additive interior fill's own count.
    expect((d!.match(/\bM\b/g) ?? []).length).toBe(INTERIOR_BAND_COUNT);
    // Every band closes.
    expect((d!.match(/\bZ\b/g) ?? []).length).toBe(INTERIOR_BAND_COUNT);
    expect(attr(paths[0][1], 'fill')).toBe('#0A373C');
  });

  it('uses ONE uniform scale about the frozen body bbox inside the 86% content box (no stretch)', () => {
    const transform = largeFigureTransform(LARGE);
    // Exactly `translate(<tx> <ty>) scale(<s>)` — a two-argument scale() is forbidden.
    const match = transform.match(/^translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)$/);
    expect(match).not.toBeNull();
    if (!match) return;

    const bbox = FIGURE_BBOX;
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

  it('is byte-identical to the pre-cut-over master (SHA-256 pin)', () => {
    const text = readFileSync(resolve(ICONS_DIR, 'fredo-icon-large.svg'), 'utf8');
    const normalised = text.replace(/\r\n/g, '\n');
    const digest = createHash('sha256').update(normalised).digest('hex');
    expect(digest).toBe(ICON_SHA256);
    // Non-vacuity: the pin is over real, non-empty content and the normalisation
    // is the identity function on an LF checkout (so the pin is not a no-op).
    expect(normalised.length).toBeGreaterThan(5_000);
    expect(normalised).not.toContain('\r');
  });
});

describe('#3210 icon source — exactly one master drives every artifact', () => {
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

  it('generator writes nothing under the avatar component tree', () => {
    expect(GENERATOR_SOURCE).not.toContain('shared/components/fredo-avatar');
  });
});
