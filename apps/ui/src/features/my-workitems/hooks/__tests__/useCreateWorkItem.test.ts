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
  createWorkItem: vi.fn(),
}));
vi.mock('../../../../shared/utils/patStorage', () => ({
  getPAT: vi.fn(() => 'mock-pat'),
  getOrg: vi.fn(() => 'mock-org'),
  getProject: vi.fn(() => 'mock-project'),
}));

import { useCreateWorkItem } from '../useCreateWorkItem';
import { createWorkItem } from '../../../../shared/utils/azdoApi';

describe('useCreateWorkItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return initial state with no error and not loading', () => {
    const { result } = renderHook(() => useCreateWorkItem());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.create).toBeInstanceOf(Function);
  });

  it('should create a work item successfully (state transition)', async () => {
    const mockCreated = { id: 101, fields: { 'System.Id': 101 } };
    (createWorkItem as ReturnType<typeof vi.fn>).mockResolvedValue(mockCreated);

    const { result } = renderHook(() => useCreateWorkItem());

    await act(async () => {
      const response = await result.current.create({ title: 'New Item', type: 'Task', description: 'desc' });
      expect(response.workItemId).toBe(101);
      expect(response.workItemUrl).toContain('dev.azure.com');
    });

    expect(createWorkItem).toHaveBeenCalledWith(
      'mock-org', 'mock-pat', 'mock-project',
      { title: 'New Item', type: 'Task', description: 'desc' },
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should set error when creation fails due to API error (edge case: error path)', async () => {
    (createWorkItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API failure'));

    const { result } = renderHook(() => useCreateWorkItem());

    await act(async () => {
      try {
        await result.current.create({ title: 'Fail', type: 'Bug', description: '' });
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('API failure');
    expect(result.current.isLoading).toBe(false);
  });

  it('should set loading to true during creation', async () => {
    let resolvePromise!: (value: unknown) => void;
    (createWorkItem as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { resolvePromise = resolve; }),
    );

    const { result } = renderHook(() => useCreateWorkItem());

    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.create({ title: 'Slow', type: 'Task', description: '' });
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolvePromise({ id: 1, fields: { 'System.Id': 1 } });
      await promise;
    });

    expect(result.current.isLoading).toBe(false);
  });
});
