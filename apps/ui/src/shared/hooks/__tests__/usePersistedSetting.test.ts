/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePersistedSetting } from '../usePersistedSetting';

// Mock settingsService
vi.mock('../../../features/settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
  serializeValue: (v: unknown) => JSON.stringify(v),
}));

import { settingsService } from '../../../features/settings';

describe('usePersistedSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the default value initially', () => {
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue('default');

    const { result } = renderHook(() =>
      usePersistedSetting('test-key', 'default'),
    );

    expect(result.current[0]).toBe('default');
  });

  it('should load persisted value from settingsService on mount', async () => {
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue('stored');

    const { result } = renderHook(() =>
      usePersistedSetting('test-key', 'fallback'),
    );

    await waitFor(() => {
      expect(result.current[0]).toBe('stored');
    });

    expect(settingsService.get).toHaveBeenCalledWith('test-key', 'fallback', undefined);
  });

  it('should fall back to default when settingsService returns undefined (edge case)', async () => {
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      usePersistedSetting('test-key', 42),
    );

    await waitFor(() => {
      expect(result.current[0]).toBe(42);
    });
  });

  it('should update value and persist via setValue', async () => {
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue('initial');

    const { result } = renderHook(() =>
      usePersistedSetting('test-key', 'default'),
    );

    await waitFor(() => expect(result.current[0]).toBe('initial'));

    act(() => {
      result.current[1]('updated');
    });

    expect(result.current[0]).toBe('updated');
    expect(settingsService.set).toHaveBeenCalledWith('test-key', '"updated"');
  });

  it('should not overwrite with async load if user already set a value', async () => {
    // Simulate slow async load
    (settingsService.get as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
    );

    const { result } = renderHook(() =>
      usePersistedSetting('test-key', 'default'),
    );

    // User sets a value before load completes
    act(() => {
      result.current[1]('user-value');
    });

    expect(result.current[0]).toBe('user-value');

    // Wait and ensure the async load doesn't overwrite
    await waitFor(() => {
      // Should still be the user-set value
      expect(result.current[0]).toBe('user-value');
    });
  });
});
