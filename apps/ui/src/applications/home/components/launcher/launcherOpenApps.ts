/**
 * launcherOpenApps — the pure query-filter + accessible-label rules for the
 * in-launcher "Open apps" row (Spec #2954 ST-1).
 *
 * ONE source of truth for two rules the host and the presentational row share:
 *   1. `filterOpenWindows` — the SAME case-insensitive title-substring predicate
 *      the launcher applies to its app grid, so the row and the grid filter from
 *      one query (R-4). The row receives an ALREADY-filtered list; this helper is
 *      what the host calls to produce it.
 *   2. `openAppEntryLabel` — the accessible entry name (title + minimized /
 *      active / background state), relocated verbatim from the retired dock
 *      entry (DockEntry.tsx:48-52) so the label semantics survive the dock's
 *      removal.
 *
 * Pure, framework-free, no window-engine writes.
 */

import type { WindowEntry } from '../../../../shared/window-system/windowTypes';

/**
 * Case-insensitive substring match on `win.title`. An empty or whitespace-only
 * query returns ALL windows unchanged (the unfiltered baseline). The input order
 * is preserved — the row lists windows in the kernel-snapshot order, never
 * re-sorted here.
 */
export function filterOpenWindows(windows: WindowEntry[], query: string): WindowEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return windows;
  return windows.filter((win) => win.title.toLowerCase().includes(needle));
}

/**
 * Accessible name = app title + window state. Precedence: minimized wins over
 * focused (a minimized window is never "active"), matching the retired
 * `dockEntryLabel` semantics exactly.
 */
export function openAppEntryLabel(win: WindowEntry): string {
  if (win.isMinimized) return `${win.title} (minimized)`;
  if (win.focused) return `${win.title} (active)`;
  return `${win.title} (background)`;
}
