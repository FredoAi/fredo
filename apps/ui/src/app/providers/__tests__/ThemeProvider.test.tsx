/**
 * #2758 — Invalid persisted theme fallback.
 * A stale/non-literal 'Fredo_theme' storage value must NOT make
 * useTheme().theme undefined (the crash behind the
 * "Cannot read properties of undefined (reading 'colors')" TypeError);
 * ThemeProvider clamps it to the 'classic' record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../ThemeProvider';
import { themes } from '../../types/theme';

// Mock settingsService (same pattern as usePersistedSetting.test.ts)
vi.mock('../../../features/settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
  serializeValue: (v: unknown) => JSON.stringify(v),
}));

import { settingsService } from '../../../features/settings';

describe('ThemeProvider invalid persisted theme fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the classic record when persisted Fredo_theme is outside the literal set', async () => {
    let loaded = false;
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async () => {
      loaded = true;
      return 'stale-nonliteral-mode';
    });

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    // Ensure the async persisted load actually delivered the invalid value
    await waitFor(() => expect(loaded).toBe(true));
    // Flush the resulting setState before asserting on the clamped output
    await act(async () => {});

    expect(result.current.currentTheme).toBe('classic');
    expect(result.current.theme).toBeDefined();
    expect(result.current.theme).toBe(themes.classic);
  });
});
