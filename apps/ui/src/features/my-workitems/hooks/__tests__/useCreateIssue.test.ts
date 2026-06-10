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

import { useCreateIssue } from '../useCreateIssue';
import type { CreateIssueData } from '../../types';

describe('useCreateIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return initial state with no error and not loading', () => {
    const { result } = renderHook(() => useCreateIssue());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.create).toBeInstanceOf(Function);
  });

  it('should create a Jira issue successfully (state transition)', async () => {
    const mockResponse = {
      success: true,
      issue: {
        key: 'PROJ-123',
        url: 'https://jira.example.com/browse/PROJ-123',
        summary: 'Test issue',
        issueType: 'Bug',
      },
      isMockData: false,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const { result } = renderHook(() => useCreateIssue());

    const issueData: CreateIssueData = {
      projectKey: 'PROJ',
      summary: 'Test issue',
      issueType: 'Bug',
      description: 'Description',
    };

    await act(async () => {
      const created = await result.current.create(issueData);
      expect(created.key).toBe('PROJ-123');
      expect(created.url).toContain('jira.example.com');
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/jira/issues'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(issueData),
      }),
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should handle HTTP error response (edge case: error path)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    });

    const { result } = renderHook(() => useCreateIssue());

    await act(async () => {
      try {
        await result.current.create({ projectKey: 'PROJ', summary: 'Fail', issueType: 'Bug' });
      } catch {
        // expected
      }
    });

    expect(result.current.error).toContain('500');
    expect(result.current.isLoading).toBe(false);
  });

  it('should handle fetch rejection (edge case: network error)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useCreateIssue());

    await act(async () => {
      try {
        await result.current.create({ projectKey: 'PROJ', summary: 'Fail', issueType: 'Bug' });
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.isLoading).toBe(false);
  });

  it('should handle API error response (success: false)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, error: 'Project not found' }),
    });

    const { result } = renderHook(() => useCreateIssue());

    await act(async () => {
      try {
        await result.current.create({ projectKey: 'INVALID', summary: 'Test', issueType: 'Bug' });
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('Project not found');
  });

  it('should set isMockData when mock data is returned', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        issue: { key: 'MOCK-1', url: '', summary: 'Mock', issueType: 'Task' },
        isMockData: true,
      }),
    });

    const { result } = renderHook(() => useCreateIssue());

    await act(async () => {
      const created = await result.current.create({ projectKey: 'MOCK', summary: 'Test', issueType: 'Task' });
      expect(created.isMockData).toBe(true);
    });
  });

  it('should show loading during creation', async () => {
    let resolvePromise!: (value: unknown) => void;
    mockFetch.mockImplementation(
      () => new Promise((resolve) => { resolvePromise = resolve; }),
    );

    const { result } = renderHook(() => useCreateIssue());

    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.create({ projectKey: 'PROJ', summary: 'Slow', issueType: 'Task' });
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolvePromise({
        ok: true,
        json: async () => ({ success: true, issue: { key: 'PROJ-1', url: '', summary: '', issueType: '' }, isMockData: false }),
      });
      await promise;
    });

    expect(result.current.isLoading).toBe(false);
  });
});
