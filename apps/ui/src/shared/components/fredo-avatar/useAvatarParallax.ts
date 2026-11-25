import { useEffect, useRef } from 'react';

/**
 * Subtle pointer parallax for the FREDO avatar.
 *
 * Attach the returned ref to the **consumer's wrapper** around `<FredoAvatar>`,
 * never inside the shared component: whole-element motion belongs to the
 * consumer (see the header of `fredoAvatarIdle.css`, #2850) so the launcher's
 * idle DOM stays byte-identical.
 *
 * The wrapper drifts a few pixels toward the cursor and tilts about a degree.
 * It writes the standalone `translate` / `rotate` CSS properties rather than
 * `transform`, because a consumer wrapper may already animate `transform` (the
 * idle bob) and those two properties compose instead of overriding each other.
 *
 * Deliberately **no React state**: the eased values are written straight to the
 * element in a `requestAnimationFrame` loop. A `setState` per pointer event
 * would re-render the avatar (58 rects + expression overlay) on every mouse
 * move, and a state-driven effect would risk the re-render loop the engineering
 * rules call out.
 *
 * `prefers-reduced-motion: reduce` disables it entirely - the listeners are not
 * even bound.
 */
export function useAvatarParallax<T extends HTMLElement>(
  enabled = true,
): { current: T | null } {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;

    // Respect the OS setting: no motion at all, and do not bind listeners.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    // Deliberately tiny: this should read as the avatar noticing you, not as a
    // effect. Raise only with a design decision.
    const MAX_SHIFT_PX = 3;
    const MAX_TILT_DEG = 1.1;

    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let frame = 0;
    let running = false;

    // Fraction of the gap closed per frame - slow enough to read as weight.
    const EASE = 0.12;
    const SETTLE = 0.001;

    const write = () => {
      // Read the node lazily: consumers may remount the wrapper (the companion
      // does, keyed on `animKey`), so a node captured at mount goes stale.
      const el = ref.current;
      if (!el) return;
      // Standalone properties: they compose with a `transform` animation.
      el.style.translate = `${(currentX * MAX_SHIFT_PX).toFixed(2)}px ${(
        currentY * MAX_SHIFT_PX
      ).toFixed(2)}px`;
      el.style.rotate = `${(currentX * MAX_TILT_DEG).toFixed(2)}deg`;
    };

    const tick = () => {
      currentX += (targetX - currentX) * EASE;
      currentY += (targetY - currentY) * EASE;

      if (
        Math.abs(targetX - currentX) < SETTLE &&
        Math.abs(targetY - currentY) < SETTLE
      ) {
        currentX = targetX;
        currentY = targetY;
        write();
        running = false;
        return;
      }

      write();
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(tick);
    };

    const onPointerMove = (event: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const centreX = rect.left + rect.width / 2;
      const centreY = rect.top + rect.height / 2;

      // Normalise against the avatar's own size (not the viewport) so the tilt
      // is consistent in the launcher and the dock, and clamp so a pointer at
      // the screen edge cannot over-rotate it.
      const spanX = rect.width * 1.5;
      const spanY = rect.height * 1.5;

      targetX = Math.max(-1, Math.min(1, (event.clientX - centreX) / spanX));
      targetY = Math.max(-1, Math.min(1, (event.clientY - centreY) / spanY));
      start();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return ref;
}
