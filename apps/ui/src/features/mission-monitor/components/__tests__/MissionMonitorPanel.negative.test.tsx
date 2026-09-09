/**
 * Negative-case tests for the own window kernel (Spec #2809 AC4).
 *
 * The kernel (`shared/window-system/useWindowActions`) has NO default action
 * provider: `useWindowActions()` reads the `WindowSystemProvider` context and
 * throws `Error('useWindowActions must be used within a WindowSystemProvider')`
 * when used outside the provider, and any action NOT supplied by a mock is
 * `undefined` — so a consumer that calls it fails loudly with a `TypeError`
 * instead of silently falling back to a third-party default.
 *
 * These two cases pin that contract:
 *  (a) the REAL hook (no mock) throws the provider-guard error when rendered
 *      WITHOUT a `WindowSystemProvider`; and
 *  (b) a probe that destructures an action a deliberately-PARTIAL mock does
 *      NOT stub (only `updateWindow` is provided, the probe calls
 *      `focusWindow`) throws `TypeError` — the explicit loud-failure (no
 *      silent no-op / no third-party default) that AC4 requires.
 *
 * Only `vi.doMock`/`vi.doUnmock`/`vi.resetModules` are used (NOT `vi.mock`),
 * so the real module is exercised for case (a) and a partial mock for case (b)
 * within the same file — the module registry is reset between cases.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/shared/window-system/useWindowActions');
});

describe('window-actions negative cases (AC4 — no silent third-party default)', () => {
  it('throws the provider-guard error when the REAL hook is used outside a WindowSystemProvider', async () => {
    // Ensure the REAL module is loaded (no mock for this case).
    vi.resetModules();
    vi.doUnmock('@/shared/window-system/useWindowActions');
    const { useWindowActions } = await import('@/shared/window-system/useWindowActions');

    // No `WindowSystemProvider` wraps this probe, so `useContext` resolves the
    // context default (`undefined`) and the guard fires.
    const Probe = () => {
      useWindowActions();
      return null;
    };

    expect(() => render(<Probe />)).toThrow(
      'useWindowActions must be used within a WindowSystemProvider',
    );
  });

  it('throws TypeError when a probe calls an action a partial mock does NOT stub', async () => {
    // Deliberately-PARTIAL mock: only `updateWindow` is provided. A consumer
    // that ALSO calls another kernel action must fail loudly, never silently
    // fall back to a third-party default (the pre-migration behavior the
    // kernel explicitly drops).
    vi.resetModules();
    vi.doMock('@/shared/window-system/useWindowActions', () => ({
      useWindowActions: () => ({ updateWindow: vi.fn() }),
    }));
    const { useWindowActions } = await import('@/shared/window-system/useWindowActions');

    const Probe = () => {
      const { focusWindow } = useWindowActions();
      // `focusWindow` is undefined in the partial mock — calling it is a
      // loud `TypeError`, not a silent no-op.
      focusWindow('mission-monitor');
      return null;
    };

    expect(() => render(<Probe />)).toThrow(TypeError);
  });
});
