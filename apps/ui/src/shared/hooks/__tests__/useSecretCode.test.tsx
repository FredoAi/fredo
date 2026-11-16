/**
 * Spec #2970 ST-5 — pins the generic `useSecretCode` document-keydown host:
 * case-insensitive matching, modifier-free only, editable-control exclusion,
 * a mismatch reset, and listener cleanup on unmount.
 */
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSecretCode } from '../useSecretCode';

function press(key: string, options: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
}

function typeSequence(keys: string[]): void {
  keys.forEach((key) => press(key));
}

afterEach(() => {
  cleanup();
});

describe('useSecretCode', () => {
  it('fires on the exact case-insensitive sequence', () => {
    const onComplete = vi.fn();
    renderHook(() => useSecretCode('iddqd', onComplete));

    typeSequence(['i', 'd', 'd', 'q', 'd']);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('matches case-insensitively', () => {
    const onComplete = vi.fn();
    renderHook(() => useSecretCode('iddqd', onComplete));

    typeSequence(['I', 'D', 'D', 'Q', 'D']);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('resets on a mismatch (a near miss does not fire)', () => {
    const onComplete = vi.fn();
    renderHook(() => useSecretCode('iddqd', onComplete));

    typeSequence(['i', 'd', 'x', 'd', 'q', 'd']);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ignores keys pressed with a modifier', () => {
    const onComplete = vi.fn();
    renderHook(() => useSecretCode('iddqd', onComplete));

    typeSequence(['i', 'd', 'd', 'q']);
    press('d', { ctrlKey: true });
    expect(onComplete).not.toHaveBeenCalled();

    // A modifier-free completion afterwards still works.
    press('d');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('ignores keys originating inside an editable control', () => {
    const onComplete = vi.fn();
    renderHook(() => useSecretCode('iddqd', onComplete));

    const input = document.createElement('input');
    document.body.appendChild(input);
    ['i', 'd', 'd', 'q', 'd'].forEach((key) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
    input.remove();

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount', () => {
    const onComplete = vi.fn();
    const { unmount } = renderHook(() => useSecretCode('iddqd', onComplete));
    unmount();

    typeSequence(['i', 'd', 'd', 'q', 'd']);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('resets after a successful completion (a second sequence fires again)', () => {
    const onComplete = vi.fn();
    renderHook(() => useSecretCode('iddqd', onComplete));

    typeSequence(['i', 'd', 'd', 'q', 'd']);
    typeSequence(['i', 'd', 'd', 'q', 'd']);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});
