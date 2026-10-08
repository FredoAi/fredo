/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { useOptimizelyFlags } from '../useOptimizelyFlags';

describe('useOptimizelyFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return loading state initially', () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ flags: [], isMockData: false }),
    });

    const { result } = renderHook(() => useOptimizelyFlags());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.flags).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should fetch and return flags on mount (state transition)', async () => {
    const mockFlags = [
      { key: 'flag-1', enabled: true, environment: 'production', name: 'Flag 1', description: '', lastModified: '', status: 'active' },
      { key: 'flag-2', enabled: false, environment: 'staging', name: 'Flag 2', description: '', lastModified: '', status: 'inactive' },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ flags: mockFlags, isMockData: false }),
    });

    const { result } = renderHook(() => useOptimizelyFlags());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.flags).toHaveLength(2);
    expect(result.current.flags[0].key).toBe('flag-1');
    expect(result.current.error).toBeNull();
    expect(result.current.isMockData).toBe(false);
  });

  it('should handle fetch error (edge case: error path)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useOptimizelyFlags());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.flags).toEqual([]);
  });

  it('should handle HTTP error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useOptimizelyFlags());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toContain('500');
  });

  it('should pass environment and status filter params', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ flags: [], isMockData: false }),
    });

    renderHook(() => useOptimizelyFlags('production', 'active'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('environment=production');
    expect(url).toContain('statusFilter=active');
  });

  it('should refetch on refetch call', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ flags: [], isMockData: false }),
    });

    const { result } = renderHook(() => useOptimizelyFlags());

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ flags: [{ key: 'new-flag', enabled: true, environment: 'dev', name: 'New', description: '', lastModified: '', status: 'active' }], isMockData: false }),
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.flags).toHaveLength(1);
    expect(result.current.flags[0].key).toBe('new-flag');
  });

  it('should handle missing optional params (edge case)', () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ flags: [], isMockData: false }),
    });

    renderHook(() => useOptimizelyFlags(undefined, undefined));

    expect(mockFetch).toHaveBeenCalled();
    const url = mockFetch.mock.calls[0][0];
    expect(url).not.toContain('environment');
    expect(url).not.toContain('statusFilter');
  });
});
