/**
 * Canvas-scoped error boundary (Spec #3070, ST-2 round 2, ST-2d).
 *
 * Round 1 showed that an uncaught canvas throw unmounted the whole React root
 * (blank webview). These pins prove containment:
 *  - a throwing child is replaced by `wireframe-canvas-error` while its
 *    siblings (the toolbar/panel surrogate) stay mounted;
 *  - `WireframeCanvas` catches a throwing implementation — the throw never
 *    escapes the tree.
 *
 * Assertion-only: no Konva import and no canvas mock.
 */

import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframeCanvas } from '../components/WireframeCanvas';
import {
  CANVAS_ERROR_MESSAGE,
  WireframeCanvasBoundary,
} from '../components/WireframeCanvasBoundary';

vi.mock('../components/WireframeCanvasImpl', () => ({
  default: function ThrowingWireframeCanvasImpl(): never {
    throw new Error('canvas exploded');
  },
}));

function Bomb(): ReactElement {
  throw new Error('canvas exploded');
}

beforeEach(() => {
  // React reports caught render errors via console.error; keep the run quiet.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WireframeCanvasBoundary', () => {
  it('replaces only the failing canvas subtree and keeps its siblings mounted', () => {
    renderWithChakra(
      <div>
        <div data-testid="toolbar-surrogate">toolbar</div>
        <WireframeCanvasBoundary>
          <Bomb />
        </WireframeCanvasBoundary>
        <div data-testid="status-surrogate">status</div>
      </div>,
    );

    const error = screen.getByTestId('wireframe-canvas-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent(CANVAS_ERROR_MESSAGE);
    expect(screen.getByTestId('toolbar-surrogate')).toBeInTheDocument();
    expect(screen.getByTestId('status-surrogate')).toBeInTheDocument();
  });

  it('catches a throwing canvas implementation instead of unmounting the tree', async () => {
    renderWithChakra(
      <div>
        <div data-testid="toolbar-surrogate">toolbar</div>
        <WireframeCanvas />
      </div>,
    );

    // The lazy implementation rejects/throws during render; the boundary — not
    // the root — must absorb it. Reaching this assertion at all proves the
    // throw did not escape.
    expect(await screen.findByTestId('wireframe-canvas-error')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar-surrogate')).toBeInTheDocument();
  });
});
