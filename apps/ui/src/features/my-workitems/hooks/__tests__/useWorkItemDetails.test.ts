/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock dependencies
vi.mock('../../../../shared/utils/azdoApi', () => ({
  getWorkItemDetails: vi.fn(),
}));
vi.mock('../../../../shared/utils/patStorage', () => ({
  getPAT: vi.fn(() => 'mock-pat'),
  getOrg: vi.fn(() => 'mock-org'),
  getProject: vi.fn(() => 'mock-project'),
}));

import { useWorkItemDetails } from '../useWorkItemDetails';
import { getWorkItemDetails } from '../../../../shared/utils/azdoApi';

describe('useWorkItemDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null workItem and not loading when workItemId is null (initial state)', () => {
    const { result } = renderHook(() => useWorkItemDetails(null));

    expect(result.current.workItem).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should return null workItem and not loading when workItemId is undefined', () => {
    const { result } = renderHook(() => useWorkItemDetails(undefined));

    expect(result.current.workItem).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should fetch work item details on mount with valid id (state transition)', async () => {
    const mockDetails = {
      id: 42,
      fields: { 'System.Title': 'Test Item', 'System.State': 'Active' },
      _links: { html: { href: 'https://dev.azure.com/item/42' } },
    };
    (getWorkItemDetails as ReturnType<typeof vi.fn>).mockResolvedValue(mockDetails);

    const { result } = renderHook(() => useWorkItemDetails(42));

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.workItem).toEqual(mockDetails);
    expect(result.current.error).toBeNull();
  });

  it('should not fetch when workItemId is 0 (edge case: falsy input)', () => {
    const { result } = renderHook(() => useWorkItemDetails(0));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.workItem).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('should handle fetch error (edge case: error path)', async () => {
    (getWorkItemDetails as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

    const { result } = renderHook(() => useWorkItemDetails(42));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('API error');
    expect(result.current.workItem).toBeNull();
  });

  it('should refetch when refetch is called', async () => {
    const mockDetails = {
      id: 42,
      fields: { 'System.Title': 'Refetched', 'System.State': 'Active' },
      _links: { html: { href: 'https://dev.azure.com/item/42' } },
    };
    (getWorkItemDetails as ReturnType<typeof vi.fn>).mockResolvedValue(mockDetails);

    const { result } = renderHook(() => useWorkItemDetails(42));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    (getWorkItemDetails as ReturnType<typeof vi.fn>).mockClear();
    (getWorkItemDetails as ReturnType<typeof vi.fn>).mockResolvedValue(mockDetails);

    await act(async () => {
      await result.current.refetch();
    });

    expect(getWorkItemDetails).toHaveBeenCalledTimes(1);
    expect(result.current.workItem?.fields['System.Title']).toBe('Refetched');
  });

  it('should reset state when workItemId changes to null', async () => {
    const mockDetails = {
      id: 42,
      fields: { 'System.Title': 'Test', 'System.State': 'Active' },
      _links: { html: { href: 'https://dev.azure.com/item/42' } },
    };
    (getWorkItemDetails as ReturnType<typeof vi.fn>).mockResolvedValue(mockDetails);

    const { result, rerender } = renderHook(
      (id: number | null | undefined) => useWorkItemDetails(id),
      { initialProps: 42 as number | null | undefined },
    );

    await waitFor(() => {
      expect(result.current.workItem).not.toBeNull();
    });

    rerender(null);

    expect(result.current.workItem).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
