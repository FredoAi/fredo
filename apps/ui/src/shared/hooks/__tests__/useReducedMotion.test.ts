/**
 * Reduced-motion hook pin (Spec #3151 ST-1) — NFR-2's surviving reduced-motion
 * read, re-homed to `shared/hooks/useReducedMotion.ts`.
 *
 * jsdom has no media engine, so the LIVE OS flip cannot be driven here; this
 * suite proves the decidable legs the contract names:
 *   (a) `useReducedMotion()` answers from a stubbed `matchMedia` (`true`/`false`);
 *   (b) it FAILS SAFE to `false` when `matchMedia` is unavailable;
 *   (c) it re-reads the CURRENT `matchMedia` on every render (a post-mount
 *       replacement is honoured on the next render, not only on re-subscribe);
 *   (d) it re-subscribes to the current list's `change` event;
 *   (e) the snapshot is a primitive boolean — the component does not re-render in
 *       a loop (the #523 failure mode).
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { REDUCED_MOTION_QUERY, useReducedMotion } from '../useReducedMotion';

/** A dependency-free `matchMedia` stub (the shipped precedent). */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** A `matchMedia` stub whose subscribed `change` listeners the test can drive. */
function stubMatchMediaDispatcher(initial: boolean): {
  dispatch: (matches: boolean) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches: initial,
    media: REDUCED_MOTION_QUERY,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => false,
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    dispatch: (matches: boolean) => {
      query.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useReducedMotion', () => {
  it('exposes the exact media query the host answers for', () => {
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('returns true while the media query matches', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('returns false when the media query does not match', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('fails safe to false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('snapshots a primitive boolean, never an object', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(typeof result.current).toBe('boolean');
  });

  it('does not re-render in a loop (the #523 primitive-snapshot rule)', () => {
    stubMatchMedia(true);
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useReducedMotion();
    });
    // One mount render (plus at most one store reconciliation) — a new-object
    // snapshot would spin here until React's update-depth guard threw.
    expect(renders).toBeLessThanOrEqual(2);
  });

  it('re-reads a post-mount matchMedia replacement on the next render', () => {
    stubMatchMedia(false);
    // A changing `label` prop forces a re-render of the SAME instance (not a
    // remount), so the new value must come from the snapshot read during render.
    const { result, rerender } = renderHook(
      ({ label }: { readonly label: string }) => {
        void label;
        return useReducedMotion();
      },
      { initialProps: { label: 'first' } },
    );
    expect(result.current).toBe(false);

    stubMatchMedia(true);
    rerender({ label: 'next' });

    expect(result.current).toBe(true);
  });

  it('re-subscribes to the current list and follows a change event', () => {
    const controller = stubMatchMediaDispatcher(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    expect(controller.listenerCount()).toBe(1);

    act(() => {
      controller.dispatch(true);
    });

    expect(result.current).toBe(true);
  });

  it('removes its change listener on unmount', () => {
    const controller = stubMatchMediaDispatcher(false);
    const { unmount } = renderHook(() => useReducedMotion());
    expect(controller.listenerCount()).toBe(1);
    unmount();
    expect(controller.listenerCount()).toBe(0);
  });
});

describe('useReducedMotion — StrictMode', () => {
  it('answers the same preference under React.StrictMode double-invoke', () => {
    stubMatchMedia(true);
    // `React.createElement` (no JSX) keeps this file a `.ts` module.
    const StrictWrapper = (props: { readonly children?: React.ReactNode }): React.ReactElement =>
      React.createElement(React.StrictMode, null, props.children);
    const { result } = renderHook(() => useReducedMotion(), { wrapper: StrictWrapper });
    expect(result.current).toBe(true);
  });
});
