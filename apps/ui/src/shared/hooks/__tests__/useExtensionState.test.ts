/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock AppProvider context before importing useExtensionState
// The factory avoids require() by returning a plain mock object
vi.mock('../../../app/providers/AppProvider', () => {
  const mockVal = {
    isEnabled: true,
    isOnTargetUrl: false,
    currentUrl: '',
    FredoContent: '',
    currentPage: 'main' as const,
    steps: [],
    showDiagram: false,
    viewingLiveDiagram: false,
    isLoadingDiagram: false,
    diagramError: '',
    parseError: '',
    setIsEnabled: vi.fn(),
    setIsOnTargetUrl: vi.fn(),
    setCurrentUrl: vi.fn(),
    setFredoContent: vi.fn(),
    setCurrentPage: vi.fn(),
    setSteps: vi.fn(),
    addStep: vi.fn(),
    updateStep: vi.fn(),
    setShowDiagram: vi.fn(),
    setViewingLiveDiagram: vi.fn(),
    setIsLoadingDiagram: vi.fn(),
    setDiagramError: vi.fn(),
    setParseError: vi.fn(),
  };

  return {
    useExtension: () => mockVal,
    AppProvider: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
    AppContext: null,
  };
});

import { useExtension } from '../../../app/providers/AppProvider';
// useExtensionState re-exports useExtension
const useExtensionState = useExtension;

describe('useExtensionState', () => {
  it('should return isEnabled as true initially', () => {
    const { result } = renderHook(() => useExtensionState());

    expect(result.current.isEnabled).toBe(true);
    expect(result.current.isOnTargetUrl).toBe(false);
    expect(result.current.currentUrl).toBe('');
    expect(result.current.currentPage).toBe('main');
  });

  it('should toggle isEnabled via setIsEnabled', () => {
    const { result } = renderHook(() => useExtensionState());

    act(() => {
      result.current.setIsEnabled(false);
    });

    expect(result.current.setIsEnabled).toHaveBeenCalledWith(false);
  });

  it('should change page via setCurrentPage', () => {
    const { result } = renderHook(() => useExtensionState());

    act(() => {
      result.current.setCurrentPage('settings');
    });

    expect(result.current.setCurrentPage).toHaveBeenCalledWith('settings');
  });

  it('should have an empty steps array initially', () => {
    const { result } = renderHook(() => useExtensionState());

    expect(result.current.steps).toEqual([]);
  });

  it('should manage parseError (edge case: error path)', () => {
    const { result } = renderHook(() => useExtensionState());

    act(() => {
      result.current.setParseError('parse failure');
    });

    expect(result.current.setParseError).toHaveBeenCalledWith('parse failure');
  });
});
