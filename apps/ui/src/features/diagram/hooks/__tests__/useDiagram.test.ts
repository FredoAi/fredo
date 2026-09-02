/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock resolveCollisions (pass through)
vi.mock('../../utils/resolveCollisions', () => ({
  resolveCollisions: (nodes: any[]) => nodes,
}));

import { useDiagram } from '../useDiagram';

describe('useDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('should return initial state (loading: false, empty nodes/edges)', () => {
    const { result } = renderHook(() => useDiagram());

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should fetch and populate nodes/edges on refresh (state transition)', async () => {
    const mockResponse = {
      nodes: [
        {
          id: 'node-1', type: 'pod', name: 'my-pod',
          status: 'healthy', metadata: {}, createdAt: new Date().toISOString(),
        },
      ],
      edges: [],
      timestamp: new Date().toISOString(),
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const { result } = renderHook(() => useDiagram());

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/infrastructure-diagram/snapshot'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should handle fetch error (edge case: error path)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { result } = renderHook(() => useDiagram());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe('Network failure');
    expect(result.current.loading).toBe(false);
    expect(result.current.nodes).toEqual([]);
  });

  it('should handle HTTP error response (edge case)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useDiagram());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toContain('500');
    expect(result.current.loading).toBe(false);
  });
});
