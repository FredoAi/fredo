/**
 * Wireframe element creation model (Spec #3098, ST-2).
 *
 * Pins the pure shape-at-rect builder and the canonical fill-token list: shape
 * kind + defaults, reversed-drag normalization, 1-dp rounding, page-origin
 * clamping, the `ELEMENT_MIN_SIZE` floor on BOTH axes, fresh unique ids, and
 * the no-dispatch (pure) contract.
 */

import { describe, expect, it, vi } from 'vitest';

import { createNewWireframeDocument } from '../model/document';
import {
  WIREFRAME_COLOR_TOKENS,
  createShapeElementAtRect,
  isWireframeColorToken,
  type WireframeColorToken,
  type WireframeShapeDrawKind,
} from '../model/elements';
import { ELEMENT_MIN_SIZE, type WireframeRect } from '../model/geometry';
import * as store from '../store/wireframeDocumentStore';

const page = createNewWireframeDocument().page;

function create(shape: WireframeShapeDrawKind, rect: WireframeRect) {
  return createShapeElementAtRect({ shape, rect, page });
}

describe('canonical fill tokens', () => {
  it('exports the ten shipped tokens in swatch order', () => {
    const tokens: readonly WireframeColorToken[] = WIREFRAME_COLOR_TOKENS;
    expect(tokens).toEqual([
      'surface',
      'muted',
      'border',
      'text',
      'textMuted',
      'accent',
      'success',
      'warning',
      'error',
      'info',
    ]);
  });

  it('accepts exactly the ten token names and nothing else', () => {
    for (const token of WIREFRAME_COLOR_TOKENS) {
      expect(isWireframeColorToken(token)).toBe(true);
    }
    expect(isWireframeColorToken('chartreuse')).toBe(false);
    expect(isWireframeColorToken('Accent')).toBe(false);
    expect(isWireframeColorToken(' accent ')).toBe(false);
    expect(isWireframeColorToken('')).toBe(false);
  });
});

describe('createShapeElementAtRect — shape + defaults', () => {
  it('builds a rect shape element with the shipped defaults', () => {
    const element = create('rect', { x: 100, y: 80, width: 240, height: 160 });
    expect(element).not.toBeNull();
    expect(element).toMatchObject({
      type: 'shape',
      shape: 'rect',
      x: 100,
      y: 80,
      width: 240,
      height: 160,
      visible: true,
      locked: false,
      fill: 'muted',
      border: 'thin',
      radius: 'm',
    });
    expect(typeof element?.id).toBe('string');
    expect(element?.id.length).toBeGreaterThan(0);
  });

  it('builds an ellipse shape element with the same defaults', () => {
    const element = create('ellipse', { x: 20, y: 30, width: 90, height: 70 });
    expect(element).toMatchObject({
      type: 'shape',
      shape: 'ellipse',
      fill: 'muted',
      border: 'thin',
      radius: 'm',
    });
  });
});

describe('createShapeElementAtRect — geometry', () => {
  it('normalizes a reversed drag (x2 < x1, y2 < y1) to a positive rect', () => {
    const element = create('rect', { x: 340, y: 240, width: -240, height: -160 });
    expect(element).toMatchObject({ x: 100, y: 80, width: 240, height: 160 });
  });

  it('normalizes a drag reversed on one axis only', () => {
    const element = create('rect', { x: 340, y: 80, width: -240, height: 160 });
    expect(element).toMatchObject({ x: 100, y: 80, width: 240, height: 160 });
  });

  it('rounds geometry to one decimal place', () => {
    const element = create('rect', { x: 10.04, y: 20.06, width: 100.04, height: 80.06 });
    expect(element).toMatchObject({ x: 10, y: 20.1, width: 100, height: 80.1 });
  });

  it('clamps a negative origin into the page without shrinking the size', () => {
    const element = create('rect', { x: -50, y: -20, width: 120, height: 80 });
    expect(element).toMatchObject({ x: 0, y: 0, width: 120, height: 80 });
  });

  it('clamps an origin outside the page so the rect lands inside', () => {
    const element = create('rect', { x: 5000, y: 5000, width: 120, height: 80 });
    expect(element).not.toBeNull();
    expect(element?.x).toBe(page.width - 120);
    expect(element?.y).toBe(page.height - 80);
    expect(element!.x + element!.width).toBeLessThanOrEqual(page.width);
    expect(element!.y + element!.height).toBeLessThanOrEqual(page.height);
  });
});

describe('createShapeElementAtRect — minimum size', () => {
  it('returns null below ELEMENT_MIN_SIZE on the width axis', () => {
    expect(create('rect', { x: 10, y: 10, width: ELEMENT_MIN_SIZE - 1, height: 100 })).toBeNull();
  });

  it('returns null below ELEMENT_MIN_SIZE on the height axis', () => {
    expect(create('rect', { x: 10, y: 10, width: 100, height: ELEMENT_MIN_SIZE - 1 })).toBeNull();
  });

  it('returns null for a zero-size drag', () => {
    expect(create('ellipse', { x: 40, y: 40, width: 0, height: 0 })).toBeNull();
  });

  it('accepts exactly ELEMENT_MIN_SIZE on both axes', () => {
    const element = create('ellipse', {
      x: 10,
      y: 10,
      width: ELEMENT_MIN_SIZE,
      height: ELEMENT_MIN_SIZE,
    });
    expect(element).toMatchObject({
      width: ELEMENT_MIN_SIZE,
      height: ELEMENT_MIN_SIZE,
    });
  });
});

describe('createShapeElementAtRect — identity + purity', () => {
  it('generates a fresh unique id per call', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const element = create('rect', { x: 10, y: 10, width: 40, height: 40 });
      expect(element).not.toBeNull();
      ids.add(element!.id);
    }
    expect(ids.size).toBe(50);
  });

  it('never dispatches to the document store and leaves the document untouched', () => {
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    const document = createNewWireframeDocument();
    const before = JSON.stringify(document);

    create('rect', { x: 100, y: 80, width: 240, height: 160 });
    create('ellipse', { x: 0, y: 0, width: 12, height: 12 });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(document)).toBe(before);
    expect(document.elements).toHaveLength(0);
    dispatchSpy.mockRestore();
  });
});
