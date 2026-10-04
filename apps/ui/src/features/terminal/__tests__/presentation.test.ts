/**
 * Terminal presentation shim tests (Spec #2955 ST-2 — supersedes #2947 ST-1).
 *
 * #2947's Terminal-only store is generalized into `appPresentationStore`. The
 * terminal `presentation.ts` is now a thin delegating shim; this file pins the
 * preserved public names and proves each one delegates to the generalized store
 * (so the Terminal consumers keep working until ST-3/ST-4 retire the shim).
 *
 * The full store contract is pinned by
 * `shared/window-system/__tests__/appPresentationStore.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../../settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../features/featureRegistry', () => ({
  getFeatures: vi.fn(() => []),
}));

import { APP_PRESENTATION_KEY } from '../../../shared/window-system/appPresentationStore';
import { settingsService } from '../../settings';
import {
  DEFAULT_PRESENTATION,
  PRESENTATION_MODE_KEY,
  TERMINAL_APP_ID,
  TERMINAL_INTENT_AVAILABLE_EVENT,
  getTerminalPresentation,
  hydrateTerminalPresentation,
  isTerminalPresentationHydrated,
  normalizePresentationMode,
  resetTerminalPresentationStoreForTests,
  setTerminalPresentation,
  useTerminalPresentation,
} from '../presentation';

const getMock = settingsService.get as unknown as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as unknown as ReturnType<typeof vi.fn>;

function stored(map: unknown, legacy: unknown = undefined): void {
  getMock.mockImplementation(async (key: string) =>
    key === APP_PRESENTATION_KEY ? map : legacy,
  );
}

describe('terminal presentation shim (Spec #2955 ST-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTerminalPresentationStoreForTests();
    setMock.mockResolvedValue(undefined);
    stored({});
  });

  it('preserves the #2947 public names its importers use', () => {
    expect(PRESENTATION_MODE_KEY).toBe('terminal_presentation_mode');
    expect(DEFAULT_PRESENTATION).toBe('same-window');
    expect(TERMINAL_INTENT_AVAILABLE_EVENT).toBe('terminal-intent-available');
    expect(TERMINAL_APP_ID).toBe('terminal');
  });

  it('delegates normalizePresentationMode to the generalized normalizer', () => {
    expect(normalizePresentationMode(' new-window ')).toBe('new-window');
    expect(normalizePresentationMode('same-window')).toBe('same-window');
    expect(normalizePresentationMode('sideways')).toBe('same-window');
    expect(normalizePresentationMode(undefined)).toBe('same-window');
  });

  it('reads the terminal entry from the generalized store', () => {
    expect(getTerminalPresentation()).toBe('same-window');
    expect(isTerminalPresentationHydrated()).toBe(false);
  });

  it('delegates hydration (incl. the legacy migration) to the store', async () => {
    stored({}, 'new-window');
    await hydrateTerminalPresentation();
    expect(getTerminalPresentation()).toBe('new-window');
    expect(isTerminalPresentationHydrated()).toBe(true);
  });

  it('delegates setTerminalPresentation — persists under the canonical key as a JSON map', async () => {
    await setTerminalPresentation('new-window');
    expect(setMock).toHaveBeenCalledWith(
      APP_PRESENTATION_KEY,
      JSON.stringify({ terminal: 'new-window' }),
    );
  });

  it('delegates useTerminalPresentation to the generalized store', async () => {
    const { result } = renderHook(() => useTerminalPresentation());
    expect(result.current).toBe('same-window');

    await act(async () => {
      await setTerminalPresentation('new-window');
    });
    expect(result.current).toBe('new-window');
  });

  it('delegates the test reset to the generalized store', async () => {
    await setTerminalPresentation('new-window');
    expect(getTerminalPresentation()).toBe('new-window');
    resetTerminalPresentationStoreForTests();
    expect(getTerminalPresentation()).toBe('same-window');
    expect(isTerminalPresentationHydrated()).toBe(false);
  });
});
