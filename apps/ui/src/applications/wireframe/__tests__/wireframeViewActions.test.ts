/**
 * Wireframe view controls (Spec #3070, ST-5 / R-4.2-R-4.5).
 *
 * Pins the fixed zoom step + 0.1..4 clamps, the viewport-centre invariant, the
 * fit-page margin/centring maths, reset-to-100%-centred and pan mode — and
 * proves every view action leaves the document, selection, dirty flag and undo
 * history byte-identical.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultElement } from '../model/elements';
import {
  FIT_PAGE_MARGIN_PX,
  MAX_VIEW_SCALE,
  MIN_VIEW_SCALE,
  ZOOM_STEP,
  fitView,
  type WireframeViewport,
} from '../model/geometry';
import {
  dispatch,
  getSnapshot,
  markSaved,
  registerCanvasStage,
  resetWireframeStoreForTests,
  select,
  setView,
} from '../store/wireframeDocumentStore';
import { fitPage, resetView, togglePan, zoomIn, zoomOut } from '../actions/wireframeViewActions';

const VIEWPORT: WireframeViewport = { width: 800, height: 600 };

function registerStage(viewport: WireframeViewport = VIEWPORT): void {
  registerCanvasStage({
    width: () => viewport.width,
    height: () => viewport.height,
  });
}

function addText(id: string = 'element-1'): void {
  const snapshot = getSnapshot();
  dispatch('element.add', {
    element: createDefaultElement('text', {
      page: snapshot.document.page,
      elements: snapshot.document.elements,
      id,
    }),
  });
}

beforeEach(() => {
  resetWireframeStoreForTests();
});

afterEach(() => {
  registerCanvasStage(null);
});

describe('zoom in / out (R-4.2)', () => {
  it('changes the scale by exactly one fixed step per press', () => {
    registerStage();

    zoomIn();
    expect(getSnapshot().view.scale).toBe(1 + ZOOM_STEP);

    zoomOut();
    expect(getSnapshot().view.scale).toBe(1);

    zoomOut();
    expect(getSnapshot().view.scale).toBe(1 - ZOOM_STEP);
  });

  it('clamps at 400% and 10%', () => {
    registerStage();

    for (let index = 0; index < 40; index += 1) zoomIn();
    expect(getSnapshot().view.scale).toBe(MAX_VIEW_SCALE);

    for (let index = 0; index < 60; index += 1) zoomOut();
    expect(getSnapshot().view.scale).toBe(MIN_VIEW_SCALE);
  });

  it('keeps the page point under the viewport centre fixed', () => {
    registerStage();
    setView({ scale: 1, x: 17, y: -23 });

    const before = getSnapshot().view;
    const centreX = VIEWPORT.width / 2;
    const centreY = VIEWPORT.height / 2;
    const worldCentreX = (centreX - before.x) / before.scale;
    const worldCentreY = (centreY - before.y) / before.scale;

    zoomIn();
    const zoomedIn = getSnapshot().view;
    expect(zoomedIn.scale).toBe(1 + ZOOM_STEP);
    expect(worldCentreX * zoomedIn.scale + zoomedIn.x).toBeCloseTo(centreX, 6);
    expect(worldCentreY * zoomedIn.scale + zoomedIn.y).toBeCloseTo(centreY, 6);

    zoomOut();
    const zoomedBack = getSnapshot().view;
    expect(zoomedBack.scale).toBe(1);
    expect(worldCentreX * zoomedBack.scale + zoomedBack.x).toBeCloseTo(centreX, 6);
    expect(worldCentreY * zoomedBack.scale + zoomedBack.y).toBeCloseTo(centreY, 6);
  });

  it('never mutates the document, selection, dirty flag or history', () => {
    registerStage();
    addText();
    select('element-1');
    markSaved('C:\\docs\\view.wireframe.json');
    const before = getSnapshot();
    expect(before.dirty).toBe(false);
    expect(before.canUndo).toBe(true);

    zoomIn();
    zoomOut();

    const after = getSnapshot();
    expect(after.document).toBe(before.document);
    expect(after.selectedId).toBe('element-1');
    expect(after.dirty).toBe(false);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.canRedo).toBe(before.canRedo);
    expect(after.filePath).toBe(before.filePath);
  });
});

describe('fit page (R-4.4)', () => {
  it('fits the whole page inside the viewport and centres it', () => {
    registerStage();
    const page = getSnapshot().document.page;

    fitPage();
    const view = getSnapshot().view;

    expect(view).toEqual(fitView(page, VIEWPORT));
    expect(view.scale * page.width).toBeLessThanOrEqual(
      VIEWPORT.width - FIT_PAGE_MARGIN_PX * 2 + 1e-6,
    );
    expect(view.scale * page.height).toBeLessThanOrEqual(
      VIEWPORT.height - FIT_PAGE_MARGIN_PX * 2 + 1e-6,
    );
    // Centred: equal breathing room on each opposite edge.
    expect(view.x).toBeCloseTo((VIEWPORT.width - page.width * view.scale) / 2, 6);
    expect(view.y).toBeCloseTo((VIEWPORT.height - page.height * view.scale) / 2, 6);
    expect(view.x).toBeGreaterThanOrEqual(FIT_PAGE_MARGIN_PX - 1e-6);
    expect(view.y).toBeGreaterThanOrEqual(FIT_PAGE_MARGIN_PX - 1e-6);
  });

  it('fits a tall phone page without clipping and re-fits after 400% zoom', () => {
    registerStage();
    dispatch('page.update', { page: { preset: 'phone' } });
    const page = getSnapshot().document.page;
    expect(page).toEqual({ preset: 'phone', width: 390, height: 844 });

    setView({ scale: MAX_VIEW_SCALE, x: -400, y: -900 });
    fitPage();
    const view = getSnapshot().view;

    expect(view.scale * page.width).toBeLessThanOrEqual(
      VIEWPORT.width - FIT_PAGE_MARGIN_PX * 2 + 1e-6,
    );
    expect(view.scale * page.height).toBeLessThanOrEqual(
      VIEWPORT.height - FIT_PAGE_MARGIN_PX * 2 + 1e-6,
    );
    expect(view.x).toBeCloseTo((VIEWPORT.width - page.width * view.scale) / 2, 6);
    expect(view.y).toBeCloseTo((VIEWPORT.height - page.height * view.scale) / 2, 6);
  });

  it('leaves the document and history untouched', () => {
    registerStage();
    addText();
    markSaved('C:\\docs\\view.wireframe.json');
    const before = getSnapshot();

    fitPage();

    const after = getSnapshot();
    expect(after.document).toBe(before.document);
    expect(after.selectedId).toBe(before.selectedId);
    expect(after.dirty).toBe(false);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.canRedo).toBe(before.canRedo);
  });
});

describe('reset view (R-4.5)', () => {
  it('sets 100% and centres the page, clearing a pan offset', () => {
    registerStage();
    const page = getSnapshot().document.page;
    setView({ scale: 2.3, x: -517, y: 909 });

    resetView();
    const view = getSnapshot().view;

    expect(view.scale).toBe(1);
    expect(view.x).toBe((VIEWPORT.width - page.width) / 2);
    expect(view.y).toBe((VIEWPORT.height - page.height) / 2);
  });

  it('resets the scale from a clamp extreme and keeps the selection', () => {
    registerStage();
    addText();
    select('element-1');
    setView({ scale: MIN_VIEW_SCALE, x: 120, y: 40 });
    const before = getSnapshot();

    resetView();

    const after = getSnapshot();
    expect(after.view.scale).toBe(1);
    expect(after.selectedId).toBe('element-1');
    expect(after.document).toBe(before.document);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.dirty).toBe(before.dirty);
  });
});

describe('pan mode (R-4.3)', () => {
  it('flips panMode without touching the document or the view', () => {
    registerStage();
    addText();
    select('element-1');
    markSaved('C:\\docs\\view.wireframe.json');
    setView({ scale: 1.4, x: 30, y: 60 });
    const before = getSnapshot();
    expect(before.panMode).toBe(false);

    togglePan();
    const after = getSnapshot();
    expect(after.panMode).toBe(true);
    expect(after.view).toEqual(before.view);
    expect(after.document).toBe(before.document);
    expect(after.selectedId).toBe('element-1');
    expect(after.dirty).toBe(false);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.canRedo).toBe(before.canRedo);

    togglePan();
    expect(getSnapshot().panMode).toBe(false);
  });
});

describe('unmeasured stage safety', () => {
  it('keeps the current view when no stage is registered', () => {
    setView({ scale: 2, x: 12, y: -8 });
    const before = getSnapshot().view;

    expect(() => {
      fitPage();
      resetView();
      zoomIn();
      zoomOut();
    }).not.toThrow();

    expect(getSnapshot().view).toEqual(before);
  });

  it('treats a zero-sized stage as unmeasured', () => {
    registerStage({ width: 0, height: 0 });
    setView({ scale: 1.5, x: 4, y: 9 });
    const before = getSnapshot().view;

    fitPage();
    resetView();
    zoomIn();

    expect(getSnapshot().view).toEqual(before);
    // Pan mode is viewport-independent and still flips.
    togglePan();
    expect(getSnapshot().panMode).toBe(true);
  });

  it('fit and reset start working once the stage is measured', () => {
    setView({ scale: 3, x: 0, y: 0 });
    fitPage();
    expect(getSnapshot().view.scale).toBe(3);

    registerStage();
    const page = getSnapshot().document.page;
    fitPage();
    expect(getSnapshot().view).toEqual(fitView(page, VIEWPORT));

    resetView();
    expect(getSnapshot().view).toEqual({
      scale: 1,
      x: (VIEWPORT.width - page.width) / 2,
      y: (VIEWPORT.height - page.height) / 2,
    });
  });
});
