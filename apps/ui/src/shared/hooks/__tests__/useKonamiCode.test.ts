/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKonamiCode } from '../useKonamiCode';

describe('useKonamiCode', () => {
  it('should return halfwayComplete as false initially', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useKonamiCode(onComplete));

    expect(result.current.halfwayComplete).toBe(false);
  });

  it('should progress through the Konami code sequence', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useKonamiCode(onComplete));

    // Press ArrowUp twice
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    expect(result.current.halfwayComplete).toBe(false);

    // Press ArrowDown twice
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    // After ArrowUp, ArrowUp, ArrowDown, ArrowDown → index 4 → halfway not yet (need key 5)
    expect(result.current.halfwayComplete).toBe(false);

    // Press ArrowLeft twice
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); });
    // After ArrowLeft → index 5 → halfwayComplete triggers
    expect(result.current.halfwayComplete).toBe(true);
  });

  it('should call onComplete when the full code is entered', () => {
    const onComplete = vi.fn();
    renderHook(() => useKonamiCode(onComplete));

    const keys = [
      'ArrowUp', 'ArrowUp',
      'ArrowDown', 'ArrowDown',
      'ArrowLeft', 'ArrowRight',
      'ArrowLeft', 'ArrowRight',
      'b', 'a',
    ];

    for (const key of keys) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      });
    }

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('should reset on wrong key (edge case)', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useKonamiCode(onComplete));

    // Start entering the code
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });

    // Press wrong key — should reset to 0
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });

    // Now complete the first half again
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); });

    expect(result.current.halfwayComplete).toBe(true);

    // Complete
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('should reset halfwayComplete and index after completion', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useKonamiCode(onComplete));

    const keys = [
      'ArrowUp', 'ArrowUp',
      'ArrowDown', 'ArrowDown',
      'ArrowLeft', 'ArrowRight',
      'ArrowLeft', 'ArrowRight',
      'b', 'a',
    ];

    for (const key of keys) {
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key })); });
    }

    expect(onComplete).toHaveBeenCalledTimes(1);
    // After completion, state resets
    expect(result.current.halfwayComplete).toBe(false);

    // Press a wrong key — should still be reset
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })); });
    // halfwayComplete should still be false
    expect(result.current.halfwayComplete).toBe(false);
  });

  it('should call the latest onComplete when it changes (edge case)', () => {
    const onComplete1 = vi.fn();
    const onComplete2 = vi.fn();
    const { rerender } = renderHook(
      (cb: () => void) => useKonamiCode(cb),
      { initialProps: onComplete1 },
    );

    // Change callback
    rerender(onComplete2);

    const keys = [
      'ArrowUp', 'ArrowUp',
      'ArrowDown', 'ArrowDown',
      'ArrowLeft', 'ArrowRight',
      'ArrowLeft', 'ArrowRight',
      'b', 'a',
    ];

    for (const key of keys) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      });
    }

    expect(onComplete1).not.toHaveBeenCalled();
    expect(onComplete2).toHaveBeenCalledTimes(1);
  });
});
