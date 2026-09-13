/**
 * #2870 round-4 — reduced-motion pin for the shared welcome `SpeechBubble`.
 *
 * STATIC / PRODUCT-UNIT PIN. The live reduced-motion leg is NOT drivable on this
 * host (#2850 F-19 / #2854 F-38: the driver cannot flip
 * `window.matchMedia('(prefers-reduced-motion: reduce)')`), so this test pins the
 * contract by mocking framer-motion's `useReducedMotion` and capturing the props
 * passed to the bubble's `motion.div`. It is NOT a live reduced-motion claim.
 *
 * Contract (UI/UX spec §3, line 220): under `prefers-reduced-motion: reduce` the
 * bubble's entry/exit is FADE-ONLY (opacity 0 → 1 → 0, no `scale`, no `y`) with a
 * non-spring transition; otherwise the existing spring (scale 0.88, `y` delta) is
 * used. Absolute-mode centring (`style.x === '-50%'`) is preserved in both branches.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SpeechBubble } from '@/shared/components/companion/SpeechBubble';

// ── Module mocks ────────────────────────────────────────────────────────────────
// Mutable reduced-motion flag read by the framer-motion mock on every render.
const reducedMotion = vi.hoisted(() => ({ value: false }));

const motionMock = vi.hoisted(() => {
  let react: { createElement: (tag: string, props: unknown, ...children: unknown[]) => unknown } | null = null;
  const captured: Array<Record<string, unknown>> = [];
  const motion = {
    div: (props: Record<string, unknown>) => {
      captured.push(props);
      if (!react) throw new Error('framer-motion mock: React not set yet');
      const { initial, animate, exit, transition, style, children, ...rest } = props;
      void initial;
      void animate;
      void exit;
      void transition;
      // `x` is a framer-motion transform value, not a valid CSS property — strip it
      // from the mocked DOM node to keep React quiet. Props assertions read `captured`.
      const domStyle =
        style && typeof style === 'object'
          ? { ...(style as Record<string, unknown>) }
          : style;
      if (domStyle && typeof domStyle === 'object') {
        delete (domStyle as Record<string, unknown>).x;
      }
      return react.createElement('div', { ...rest, style: domStyle }, children);
    },
  };
  return {
    setReact(r: typeof react) { react = r; },
    motion,
    captured,
    AnimatePresence: ({ children }: { children?: unknown }) => children ?? null,
  };
});

vi.mock('framer-motion', () => ({
  AnimatePresence: motionMock.AnimatePresence,
  motion: motionMock.motion,
  useReducedMotion: () => reducedMotion.value,
}));

motionMock.setReact(React);

// ── Helpers ─────────────────────────────────────────────────────────────────────
const lastCapture = (): Record<string, unknown> => {
  expect(motionMock.captured.length).toBeGreaterThan(0);
  return motionMock.captured[motionMock.captured.length - 1];
};

const renderBubble = (positioning: 'absolute' | 'fixed') =>
  renderWithChakra(
    <SpeechBubble
      message="At your service. How can I help?"
      companionX={480}
      companionY={300}
      positioning={positioning}
    />,
  );

beforeEach(() => {
  motionMock.captured.length = 0;
  reducedMotion.value = false;
  cleanup();
});

describe('SpeechBubble reduced motion (#2870)', () => {
  describe('prefers-reduced-motion: reduce', () => {
    beforeEach(() => {
      reducedMotion.value = true;
    });

    it('animates opacity only — no scale/y — and uses a non-spring transition', () => {
      renderBubble('absolute');
      const props = lastCapture();

      expect(props.initial).toHaveProperty('opacity', 0);
      expect(props.animate).toHaveProperty('opacity', 1);
      expect(props.exit).toHaveProperty('opacity', 0);

      for (const phase of ['initial', 'animate', 'exit'] as const) {
        expect(props[phase]).not.toHaveProperty('scale');
        expect(props[phase]).not.toHaveProperty('y');
      }

      // Fade-only must not use the spring transition.
      expect(props.transition).not.toHaveProperty('type');
      expect(props.transition).toHaveProperty('duration');
    });

    it('preserves the absolute seat anchor (centred, tail down)', () => {
      renderBubble('absolute');
      const props = lastCapture();

      expect(props.style).toMatchObject({
        position: 'absolute',
        left: '50%',
        x: '-50%',
      });
    });

    it('preserves the fixed overlay anchor', () => {
      renderBubble('fixed');
      const props = lastCapture();

      expect(props.style).toMatchObject({ position: 'fixed' });
      expect((props.style as Record<string, unknown>).x).toBeUndefined();
    });
  });

  describe('motion enabled (regression guard)', () => {
    beforeEach(() => {
      reducedMotion.value = false;
    });

    it('keeps the spring entry with scale 0.88 / y delta', () => {
      renderBubble('absolute');
      const props = lastCapture();

      // `absolute` forces side 'above' → initDelta = 6.
      expect(props.initial).toMatchObject({ opacity: 0, scale: 0.88, y: 6 });
      expect(props.animate).toMatchObject({ opacity: 1, scale: 1, y: 0 });
      expect(props.exit).toMatchObject({ opacity: 0, scale: 0.88, y: 6 });
      expect(props.transition).toMatchObject({ type: 'spring', stiffness: 380, damping: 30 });
    });

    it('still carries the absolute centring anchor', () => {
      renderBubble('absolute');
      const props = lastCapture();

      expect(props.style).toMatchObject({ position: 'absolute', left: '50%', x: '-50%' });
    });

    it('uses the spring for the fixed overlay', () => {
      renderBubble('fixed');
      const props = lastCapture();

      expect(props.initial).toMatchObject({ scale: 0.88 });
      expect(props.transition).toMatchObject({ type: 'spring', stiffness: 380, damping: 30 });
      expect(props.style).toMatchObject({ position: 'fixed' });
    });
  });
});
