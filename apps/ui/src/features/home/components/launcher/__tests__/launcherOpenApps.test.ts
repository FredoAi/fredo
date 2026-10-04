/**
 * Spec #2954 ST-1 — the pure open-apps filter + label rules.
 *
 * Pins the ONE source of truth for the query→row predicate (R-4) and the
 * accessible entry name relocated from the retired dock.
 */

import { describe, it, expect } from 'vitest';

import type { WindowEntry } from '@/shared/window-system/windowTypes';
import { filterOpenWindows, openAppEntryLabel } from '../launcherOpenApps';

function win(over: Partial<WindowEntry> = {}): WindowEntry {
  return {
    id: 'mission-monitor',
    title: 'Mission Monitor',
    icon: null,
    component: null,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: false,
    isMinimized: false,
    focused: false,
    zIndex: 1,
    ...over,
  };
}

const mission = win({ id: 'mission-monitor', title: 'Mission Monitor', focused: true, zIndex: 2 });
const queryViewer = win({ id: 'query-viewer', title: 'Query Viewer', zIndex: 1 });
const terminal = win({ id: 'terminal', title: 'Terminal', isMinimized: true, zIndex: 3 });

describe('filterOpenWindows', () => {
  it('returns all windows for an empty query (unfiltered baseline)', () => {
    const all = [mission, queryViewer, terminal];
    expect(filterOpenWindows(all, '')).toBe(all);
  });

  it('returns all windows for a whitespace-only query', () => {
    const all = [mission, queryViewer, terminal];
    expect(filterOpenWindows(all, '   \t  ')).toBe(all);
  });

  it('matches case-insensitively on a title substring', () => {
    const all = [mission, queryViewer, terminal];
    expect(filterOpenWindows(all, 'MISS')).toEqual([mission]);
    expect(filterOpenWindows(all, 'mission monitor')).toEqual([mission]);
  });

  it('matches a mid-title substring and trims the query', () => {
    const all = [mission, queryViewer, terminal];
    expect(filterOpenWindows(all, '  viewer ')).toEqual([queryViewer]);
  });

  it('removes non-matching windows while preserving the input order', () => {
    const all = [mission, queryViewer, terminal];
    // 'i' is in every title → order preserved exactly.
    expect(filterOpenWindows(all, 'i')).toEqual([mission, queryViewer, terminal]);
    // Only Query Viewer + Terminal contain 'er'.
    expect(filterOpenWindows(all, 'er')).toEqual([queryViewer, terminal]);
  });

  it('returns an empty list when nothing matches (the host self-hides on this)', () => {
    expect(filterOpenWindows([mission, queryViewer], 'zzz')).toEqual([]);
  });
});

describe('openAppEntryLabel', () => {
  it('labels a minimized window (minimized wins over focused)', () => {
    expect(openAppEntryLabel(win({ title: 'Terminal', isMinimized: true, focused: true }))).toBe(
      'Terminal (minimized)',
    );
  });

  it('labels a focused, non-minimized window as active', () => {
    expect(openAppEntryLabel(win({ title: 'Mission Monitor', focused: true }))).toBe(
      'Mission Monitor (active)',
    );
  });

  it('labels an open-but-not-focused window as background', () => {
    expect(openAppEntryLabel(win({ title: 'Query Viewer' }))).toBe('Query Viewer (background)');
  });
});
