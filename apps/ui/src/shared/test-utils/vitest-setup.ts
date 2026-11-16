import '@testing-library/jest-dom/vitest';

/**
 * jsdom has no ResizeObserver. Chakra/Ark machine components (SegmentGroup,
 * Slider) observe their indicator/thumb on mount; without a stub those effects
 * throw asynchronously and Vitest reports unhandled errors (Spec #3070 ST-4
 * mounts both in the Wireframe property panel).
 */
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}
