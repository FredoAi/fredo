import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FredoAvatar } from '../FredoAvatar';

/**
 * #2917 ST-5 — the four NEW status states' rendered overlay contract + the
 * deterministic reduced-motion CSS pins.
 *
 * The jsdom half pins each new state's DISTINGUISHING overlay shapes (a static,
 * legible frame is present in the DOM for `listening` / `working` / `error` /
 * `greeting`). The CSS half is a STATIC/PRODUCT-UNIT pin, NOT a live
 * reduced-motion claim: the MCP driver cannot flip
 * `window.matchMedia('(prefers-reduced-motion: reduce)')` (G-053), so the source
 * contract is asserted instead — every new state keeps a legible resting frame,
 * never `opacity: 0`, and never a strobe.
 *
 * The RENDERED dense/full-frame pixel-delta perceptibility capture is a TESTER
 * LIVE ROW (#2909 precedent), never a jsdom unit test — this file does not fake a
 * raster harness.
 */

const AVATAR_CSS = 'src/shared/components/fredo-avatar/fredo-avatar.css';
const COMPANION_CSS = 'src/shared/components/companion/companion.css';

/** vitest runs with cwd = apps/ui (the package root). */
const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

/**
 * Slice the body of the `@media (prefers-reduced-motion: reduce)` block. Inner
 * rule closings are indented; the block's own closing brace sits at column 0.
 */
function reducedMotionBlock(css: string): string {
  const mediaStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
  expect(mediaStart, 'CSS must declare a @media (prefers-reduced-motion: reduce) block').toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', mediaStart);
  const close = css.indexOf('\n}', open);
  expect(open).toBeGreaterThan(mediaStart);
  expect(close).toBeGreaterThan(open);
  return css.slice(open, close + 2);
}

/** The declarations between a named `@keyframes <name>` opening and its close. */
function keyframesBody(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name}`);
  expect(start, `@keyframes ${name} must exist`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  expect(close).toBeGreaterThan(open);
  return css.slice(open, close + 2);
}

/** Split a rule block into `{ selector, body }` chunks (crude but sufficient). */
function ruleChunks(block: string): Array<{ selector: string; body: string }> {
  const inner = block.startsWith('{') ? block.slice(1) : block;
  return inner
    .split('}')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const open = chunk.indexOf('{');
      if (open < 0) return { selector: chunk, body: '' };
      return { selector: chunk.slice(0, open).trim(), body: chunk.slice(open + 1) };
    });
}

afterEach(cleanup);

describe('#2917 ST-5 — new-state overlay frames render in the DOM', () => {
  it('renders the listening 3-bar right-cheek meter with the authored bounds', () => {
    const { container } = render(<FredoAvatar size="sm" state="listening" />);
    const overlay = container.querySelector("#fredo-expression[data-state='listening']");
    expect(overlay).not.toBeNull();

    const bars = Array.from(overlay!.querySelectorAll('.fredo-listening-bar'));
    expect(bars).toHaveLength(3);
    // #2917 r2 FIX-2a (G-125, NAMED refresh): the meter bars were grown from
    // {740,448,48,120}/{792,428,48,168}/{844,464,48,88} to the 60-wide, 200 px²-
    // clearing geometry below (bottoms all at y=578, right edge x=892).
    expect(bars.map((b) => [b.getAttribute('x'), b.getAttribute('y')])).toEqual([
      ['696', '388'],
      ['764', '328'],
      ['832', '433'],
    ]);
    // Every bar keeps a ≥60-unit minimum dimension (2.5 px+ at sm).
    for (const bar of bars) {
      const width = Number(bar.getAttribute('width'));
      const height = Number(bar.getAttribute('height'));
      expect(Math.min(width, height), `bar ${bar.getAttribute('x')} min dimension`).toBeGreaterThanOrEqual(60);
    }
    // Neutral face — no mouth shape can be confused with a mouth-void state.
    expect(overlay!.querySelectorAll('rect')).toHaveLength(3);
  });

  it('renders the working two-chevron left-cheek marker', () => {
    const { container } = render(<FredoAvatar size="sm" state="working" />);
    const overlay = container.querySelector("#fredo-expression[data-state='working']");
    expect(overlay).not.toBeNull();

    const chevrons = Array.from(overlay!.querySelectorAll('.fredo-working-chevron'));
    expect(chevrons).toHaveLength(2);
    for (const chevron of chevrons) {
      expect(chevron.querySelectorAll('rect')).toHaveLength(3);
    }
    expect(overlay!.querySelectorAll('rect')).toHaveLength(6);
  });

  it('renders the error V-frown + 4 down-brows in --status.error ink', () => {
    const { container } = render(<FredoAvatar size="sm" state="error" />);
    const overlay = container.querySelector("#fredo-expression[data-state='error']");
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('color')).toBe('var(--status.error)');
    // 2 frown + 4 brow rects.
    expect(overlay!.querySelectorAll('rect')).toHaveLength(6);
  });

  it('renders the greeting hand + motion arcs + raised brows + smile', () => {
    const { container } = render(<FredoAvatar size="sm" state="greeting" />);
    const overlay = container.querySelector("#fredo-expression[data-state='greeting']");
    expect(overlay).not.toBeNull();

    const hand = overlay!.querySelector('.fredo-greeting-hand');
    expect(hand).not.toBeNull();
    expect(hand!.querySelectorAll('rect')).toHaveLength(5);
    expect(overlay!.querySelectorAll('.fredo-greeting-arc')).toHaveLength(2);
    // 5 hand + 2 arcs + 4 brows + 3 smile bars.
    expect(overlay!.querySelectorAll('rect')).toHaveLength(14);
  });
});

describe('#2917 ST-5 — reduced-motion CSS pins for the new states (STATIC)', () => {
  it('keeps the listening/working/greeting overlay motion suppressed with a legible resting frame', () => {
    const block = reducedMotionBlock(readSource(AVATAR_CSS));

    for (const [state, className] of [
      ['listening', '.fredo-listening-bar'],
      ['working', '.fredo-working-chevron'],
      ['greeting', '.fredo-greeting-hand'],
    ] as const) {
      expect(block).toContain(`#fredo-expression[data-state='${state}'] ${className}`);
    }

    // The grouped suppression rule must set `animation: none` for the new states.
    const suppressionRule = ruleChunks(block).find(
      (chunk) =>
        chunk.selector.includes('.fredo-listening-bar') &&
        chunk.selector.includes('.fredo-working-chevron') &&
        chunk.selector.includes('.fredo-greeting-hand'),
    );
    expect(suppressionRule).toBeDefined();
    expect(suppressionRule!.body).toMatch(/animation:\s*none/);
  });

  it('never resolves a new-state distinguishing shape to opacity:0 under reduced motion', () => {
    const block = reducedMotionBlock(readSource(AVATAR_CSS));
    const newStateClasses = ['.fredo-listening-bar', '.fredo-working-chevron', '.fredo-greeting-hand'];

    for (const chunk of ruleChunks(block)) {
      if (!newStateClasses.some((cls) => chunk.selector.includes(cls))) continue;
      expect(chunk.body, `reduced-motion rule for ${chunk.selector} must not erase its shape`).not.toMatch(
        /opacity:\s*0(?![.\d])/,
      );
    }

    // The working resting frame and the greeting wrist frame are explicitly kept.
    expect(block).toMatch(/\.fredo-working-chevron[^}]*transform:\s*translateX\(32px\)/);
    expect(block).toMatch(/\.fredo-greeting-hand[^}]*transform:\s*rotate\(12deg\)/);
  });

  it('suppresses the whole-element error shake under reduced motion', () => {
    const block = reducedMotionBlock(readSource(COMPANION_CSS));
    expect(block).toMatch(/\.fredo-companion-avatar\[data-state='error'\]/);
    const errorChunk = ruleChunks(block).find((chunk) =>
      chunk.selector.includes(".fredo-companion-avatar[data-state='error']"),
    );
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.body).toMatch(/animation:\s*none/);
  });

  it('declares the one-shot error wrapper shake (360 ms, forwards) in whole CSS px', () => {
    const css = readSource(COMPANION_CSS);
    const shake = keyframesBody(css, 'fredo-error-shake');
    expect(shake).toMatch(/translateX\(-3px\)/);
    expect(shake).toMatch(/translateX\(3px\)/);
    expect(shake).toMatch(/translateX\(-2px\)/);

    const errorRule = ruleChunks(css).find((chunk) =>
      chunk.selector.includes(".fredo-companion-avatar[data-state='error']"),
    );
    expect(errorRule).toBeDefined();
    expect(errorRule!.body).toMatch(/fredo-error-shake\s+360ms/);
    expect(errorRule!.body).toMatch(/forwards/);
  });
});

describe('#2917 ST-5 — no new-state overlay strobes (STATIC, WCAG 2.3.1)', () => {
  it('never flashes a new-state shape fully off (opacity 0) in the base keyframes', () => {
    const css = readSource(AVATAR_CSS);

    for (const name of ['fredo-listening-bar', 'fredo-working-chevron', 'fredo-working-chase', 'fredo-greeting-wave']) {
      const body = keyframesBody(css, name);
      expect(body, `${name} must not flash a distinguishing shape fully off`).not.toMatch(
        /opacity:\s*0(?![.\d])/,
      );
    }

    // The working chase is a partial-tone opacity swing (0.45 ↔ 1), never off.
    const chase = keyframesBody(css, 'fredo-working-chase');
    expect(chase).toMatch(/opacity:\s*0\.45/);
    expect(chase).toMatch(/opacity:\s*1/);
  });

  it('keeps the error overlay silhouette STATIC (no keyframes for the error shapes)', () => {
    // The error state's only motion is the consumer wrapper shake; the shared
    // overlay declares no animation for it.
    const css = readSource(AVATAR_CSS);
    expect(css).not.toMatch(/#fredo-expression\[data-state='error'\][^}]*animation/);
  });
});

// ── #2917 round-2 FIX-2 coverage floors (G-125, NEW pins) ─────────────────────
//
// The round-1 tester measured `listening` at delta_frac 0.00765–0.00776 vs the
// binding 0.008 floor (its 48-wide meter union was only ≈112 px² of the 18,944-px
// dense crop). The bars and chevrons were grown (FIX-2a/FIX-2c). These pins lock
// the authored-area floors so a later round cannot shrink them back below the
// floor without a re-declared calibration.

/** sm render scale: 80 CSS px / 1014 viewBox units (`fredoAvatarSizes.ts:15`). */
const SM_UNIT_PX = 0.0789;

interface AuthoredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const readRects = (root: Element): AuthoredRect[] =>
  Array.from(root.querySelectorAll('rect')).map((r) => ({
    x: Number(r.getAttribute('x')),
    y: Number(r.getAttribute('y')),
    width: Number(r.getAttribute('width')),
    height: Number(r.getAttribute('height')),
  }));

const mergedLength = (spans: ReadonlyArray<readonly [number, number]>): number => {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let length = 0;
  let start: number | null = null;
  let end = 0;
  for (const [spanStart, spanEnd] of sorted) {
    if (start === null) {
      start = spanStart;
      end = spanEnd;
    } else if (spanStart <= end) {
      end = Math.max(end, spanEnd);
    } else {
      length += end - start;
      start = spanStart;
      end = spanEnd;
    }
  }
  if (start !== null) length += end - start;
  return length;
};

/** True union area (viewBox unit²) of authored rects, scan-line by integer row. */
const unionAreaUnits = (rects: readonly AuthoredRect[]): number => {
  const minY = Math.min(...rects.map((r) => r.y));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  let area = 0;
  for (let y = minY; y < maxY; y += 1) {
    const spans = rects
      .filter((r) => r.y <= y && y < r.y + r.height)
      .map((r) => [r.x, r.x + r.width] as const);
    area += mergedLength(spans);
  }
  return area;
};

describe('#2917 r2 FIX-2 — new-state coverage floors at sm (G-125, NEW pins)', () => {
  it('listening meter union is ≥ 200 px²', () => {
    const { container } = render(<FredoAvatar size="sm" state="listening" />);
    const overlay = container.querySelector("#fredo-expression[data-state='listening']");
    expect(overlay).not.toBeNull();
    const areaPx2 = unionAreaUnits(readRects(overlay!)) * SM_UNIT_PX * SM_UNIT_PX;
    expect(areaPx2, `listening meter union = ${areaPx2.toFixed(1)} px²`).toBeGreaterThanOrEqual(200);
  });

  it('working chevron union is ≥ 120 px²', () => {
    const { container } = render(<FredoAvatar size="sm" state="working" />);
    const overlay = container.querySelector("#fredo-expression[data-state='working']");
    expect(overlay).not.toBeNull();
    const areaPx2 = unionAreaUnits(readRects(overlay!)) * SM_UNIT_PX * SM_UNIT_PX;
    expect(areaPx2, `working chevron union = ${areaPx2.toFixed(1)} px²`).toBeGreaterThanOrEqual(120);
  });
});
