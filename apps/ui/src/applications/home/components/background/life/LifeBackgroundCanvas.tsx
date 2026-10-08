/**
 * LifeBackgroundCanvas — the React binding for the Life canvas engine
 * (Spec #2915, ST-3; shared dimmed paint expression Spec #2925, ST-3).
 *
 * Renders ONE inert `<canvas>` INSIDE the existing backdrop root: the root keeps
 * `pointerEvents:none`, `aria-hidden` and `zIndex 0`, and this canvas inherits
 * that contract with no handlers. It owns the engine instance and every
 * `data-life-*` hook QA reads:
 *
 *   - `data-life-motion`  — `animated` on the animated leg, `static` when the
 *     OS reduced-motion preference removes the animation (the engine then paints
 *     exactly one seeded frame and schedules ZERO rAF/timers);
 *   - `data-life-running` — engine-mirrored; flips to `false` while the document
 *     is hidden (the rAF is CANCELLED, not merely skipped) and back on restore;
 *   - `data-life-seed`    — the per-load random seed (a determinism seam).
 *
 * Paint contract (Spec #2925): the element style carries the SAME shared dimmed
 * paint expression the engine resolves and the chooser thumbnail mirrors —
 * `color: var(--life-cell)` over `backgroundColor: var(--body-bg)`, with the
 * field-wide `--life-dim` scrim composited by `lifeEngine` after ground + cells.
 * `--life-cell` is the accent-strong cell blended toward the `--life-neutral`
 * mid-luminance chroma leg (itself `--text-primary` toward `--body-bg`), so the
 * field is less single-hue-dominant on light presets as well as dark. All three
 * consumers name the tokens only; the mix arithmetic lives once in
 * `ThemeProvider.tsx` and the authored weights in `lifeConstants.ts`. No colour
 * literal, no `var(--x)NN` alpha-append.
 *
 * The engine never runs in the settings tree: only the desktop backdrop mounts
 * this component. The chooser thumbnail is a static SVG (ST-4).
 */

import React, { useEffect, useRef, useState } from 'react';

import { createLifeEngine, resolveLifeTokens, type LifeEngine } from './lifeEngine';

export interface LifeBackgroundCanvasProps {
  /** `true` on the animated leg; `false` under OS reduced motion. */
  animated: boolean;
}

/** A fresh 32-bit seed per load (the `data-life-seed` determinism seam). */
function createSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

export const LifeBackgroundCanvas: React.FC<LifeBackgroundCanvasProps> = ({ animated }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<LifeEngine | null>(null);
  const [seed] = useState<number>(createSeed);
  const [running, setRunning] = useState<boolean>(animated);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const engine = createLifeEngine({ canvas, reducedMotion: !animated, seed });
    engineRef.current = engine;

    // The engine is created at the CSS viewport size; keep the grid/backing
    // store in step with the inert root through the shared ResizeObserver.
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (rect) engine.resize(rect.width, rect.height);
      });
      resizeObserver.observe(canvas.parentElement ?? canvas);
    }

    // AC5: cancel (never merely skip) the frame loop while the document is
    // hidden; resume from the retained state once visible again.
    const handleVisibility = (): void => {
      if (document.hidden) {
        engine.stop();
        setRunning(false);
      } else if (animated) {
        engine.start();
        setRunning(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // AC3: live recolour — re-resolve the theme custom properties whenever the
    // theme/accent mutates the document element, then repaint within a frame.
    let mutationObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(() => {
        engine.setTokens(resolveLifeTokens(canvas));
      });
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
    }

    engine.setTokens(resolveLifeTokens(canvas));
    if (animated) {
      engine.start();
      setRunning(true);
    } else {
      // Reduced motion: the engine already painted one seeded frame and will
      // never schedule a frame.
      setRunning(false);
    }

    return () => {
      resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      mutationObserver?.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [animated, seed]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="desktop-backdrop-life-canvas"
      data-background-layer="life-field"
      data-life-motion={animated ? 'animated' : 'static'}
      data-life-running={running ? 'true' : 'false'}
      data-life-seed={String(seed)}
      aria-hidden="true"
      tabIndex={-1}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        color: 'var(--life-cell)',
        backgroundColor: 'var(--body-bg)',
      }}
    />
  );
};
