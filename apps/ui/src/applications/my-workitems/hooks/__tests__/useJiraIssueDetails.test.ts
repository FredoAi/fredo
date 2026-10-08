/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { useJiraIssueDetails } from '../useJiraIssueDetails';

describe('useJiraIssueDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null issue and not loading when issueKey is null (initial state)', () => {
    const { result } = renderHook(() => useJiraIssueDetails(null));

    expect(result.current.issue).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isMockData).toBe(false);
  });

  it('should fetch issue details on mount with valid key (state transition)', async () => {
    const mockIssue = {
      key: 'PROJ-123',
      summary: 'Test issue',
      issueType: 'Bug',
      status: 'Open',
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issue: mockIssue, isMockData: false }),
    });

    const { result } = renderHook(() => useJiraIssueDetails('PROJ-123'));

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.issue).toEqual(mockIssue);
    expect(result.current.error).toBeNull();
    expect(result.current.isMockData).toBe(false);
  });

  it('should handle fetch error (edge case: error path)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { result } = renderHook(() => useJiraIssueDetails('PROJ-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Network failure');
    expect(result.current.issue).toBeNull();
  });

  it('should handle HTTP error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const { result } = renderHook(() => useJiraIssueDetails('UNKNOWN-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toContain('404');
  });

  it('should handle API error response (success: false)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, error: 'Issue not found' }),
    });

    const { result } = renderHook(() => useJiraIssueDetails('MISSING-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Issue not found');
  });

  it('should set isMockData when mock data is returned', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        issue: { key: 'MOCK-1', summary: 'Mock issue', issueType: 'Task', status: 'Active' },
        isMockData: true,
      }),
    });

    const { result } = renderHook(() => useJiraIssueDetails('MOCK-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isMockData).toBe(true);
  });

  it('should reset state when issueKey changes to null (edge case)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issue: { key: 'PROJ-1', summary: '', issueType: '', status: '' }, isMockData: false }),
    });

    const { result, rerender } = renderHook(
      (key: string | null) => useJiraIssueDetails(key),
      { initialProps: 'PROJ-1' as string | null },
    );

    await waitFor(() => {
      expect(result.current.issue).not.toBeNull();
    });

    rerender(null);

    expect(result.current.issue).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
