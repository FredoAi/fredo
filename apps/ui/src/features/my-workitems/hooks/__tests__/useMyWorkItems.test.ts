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
  getAssignedWorkItems: vi.fn(),
}));
vi.mock('../../../../shared/utils/patStorage', () => ({
  getPAT: vi.fn(() => 'mock-pat'),
  getOrg: vi.fn(() => 'mock-org'),
  getProject: vi.fn(() => 'mock-project'),
  getUserProfile: vi.fn(() => ({ id: 'user-1', displayName: 'Test User' })),
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { useMyWorkItems } from '../useMyWorkItems';
import { getAssignedWorkItems } from '../../../../shared/utils/azdoApi';

describe('useMyWorkItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return initial loading state', () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issues: [], isMockData: false }),
    });
    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { result } = renderHook(() => useMyWorkItems());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.items).toEqual([]);
    expect(result.current.azdoError).toBeNull();
    expect(result.current.jiraError).toBeNull();
  });

  it('should fetch and merge work items from both sources (state transition)', async () => {
    const mockAzdoItems = [
      { id: 1, fields: { 'System.Title': 'AzDo Item', 'System.WorkItemType': 'Task', 'System.State': 'Active', 'System.ChangedDate': '2024-01-01T00:00:00Z' } },
    ];
    const mockJiraItems = [
      { key: 'JIRA-1', summary: 'Jira Issue', issueType: 'Bug', status: 'Open', updated: '2024-01-02T00:00:00Z' },
    ];

    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockAzdoItems);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issues: mockJiraItems, isMockData: false }),
    });

    const { result } = renderHook(() => useMyWorkItems());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.azdoError).toBeNull();
    expect(result.current.jiraError).toBeNull();
  });

  it('should handle AzDo error gracefully (edge case: error path)', async () => {
    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('AzDo auth failed'));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issues: [], isMockData: false }),
    });

    const { result } = renderHook(() => useMyWorkItems());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.azdoError).toContain('AzDo auth failed');
    expect(result.current.jiraError).toBeNull();
  });

  it('should handle Jira error gracefully (edge case: error path)', async () => {
    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockFetch.mockRejectedValueOnce(new Error('Jira network error'));

    const { result } = renderHook(() => useMyWorkItems());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.azdoError).toBeNull();
    expect(result.current.jiraError).toContain('Jira network error');
  });

  it('should handle both sources failing', async () => {
    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('AzDo error'));
    mockFetch.mockRejectedValueOnce(new Error('Jira error'));

    const { result } = renderHook(() => useMyWorkItems());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.azdoError).toContain('AzDo error');
    expect(result.current.jiraError).toContain('Jira error');
    expect(result.current.items).toEqual([]);
  });

  it('should handle AzDo error when it occurs (edge case: error path)', async () => {
    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('credentials not configured'));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issues: [], isMockData: false }),
    });

    const { result } = renderHook(() => useMyWorkItems());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.azdoError).toContain('credentials not configured');
  });

  it('should refetch on refetch call', async () => {
    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issues: [], isMockData: false }),
    });

    const { result } = renderHook(() => useMyWorkItems());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    vi.clearAllMocks();
    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 99, fields: { 'System.Title': 'New Item', 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.ChangedDate': '2024-02-01T00:00:00Z' } },
    ]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issues: [], isMockData: false }),
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].title).toBe('New Item');
  });

  it('should sort items with active first, then by updatedAt', async () => {
    const mockAzdoItems = [
      { id: 1, fields: { 'System.Title': 'Done Item', 'System.WorkItemType': 'Task', 'System.State': 'Closed', 'System.ChangedDate': '2024-01-03T00:00:00Z' } },
      { id: 2, fields: { 'System.Title': 'Active Item', 'System.WorkItemType': 'Task', 'System.State': 'Active', 'System.ChangedDate': '2024-01-01T00:00:00Z' } },
      { id: 3, fields: { 'System.Title': 'In Progress', 'System.WorkItemType': 'Task', 'System.State': 'In Progress', 'System.ChangedDate': '2024-01-02T00:00:00Z' } },
    ];

    (getAssignedWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockAzdoItems);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, issues: [], isMockData: false }),
    });

    const { result } = renderHook(() => useMyWorkItems());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Active should come first, then In Progress, then Closed
    expect(result.current.items[0].title).toBe('Active Item');
    expect(result.current.items[1].title).toBe('In Progress');
    expect(result.current.items[2].title).toBe('Done Item');
  });
});
