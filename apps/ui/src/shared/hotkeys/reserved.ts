/**
 * Spec #2946 ST-1 — the fixed platform-reserved combination list (plan contract
 * block 9), Windows-first.
 *
 * These are combinations the OS / WebView2 owns; Fredo must never bind them
 * (R-5.3) and every rejection carries a human-readable reason. The list is also
 * surfaced read-only in Settings ("Reserved by the platform").
 *
 * NOTE: `ctrl+shift+f10` is deliberately NOT reserved — it is the single
 * layout-stable terminal exit-passthrough chord (R-5.7, PO#6).
 *
 * Lookup is PLATFORM-AWARE via `sequenceEquals` (keys.ts), so a normalized
 * `primary+alt+delete` matches the stored `ctrl+alt+delete` on Windows/Linux.
 */

import { parseSequence, sequenceEquals } from './keys';
import type { KeySequence, Platform, ReservedCombo } from './types';

/** The fixed set of combinations the platform owns. */
export const PLATFORM_RESERVED_COMBOS: readonly ReservedCombo[] = [
  // Editing / clipboard
  { serialized: 'primary+c', reason: 'Copy (system/WebView2)' },
  { serialized: 'primary+v', reason: 'Paste (system/WebView2)' },
  { serialized: 'primary+shift+v', reason: 'Paste without formatting (WebView2)' },
  { serialized: 'primary+x', reason: 'Cut (system/WebView2)' },
  { serialized: 'primary+a', reason: 'Select all (system/WebView2)' },
  { serialized: 'primary+z', reason: 'Undo (system/WebView2)' },
  { serialized: 'primary+y', reason: 'Redo (system/WebView2)' },
  // Window / page
  { serialized: 'primary+w', reason: 'Closes the OS window (WebView2)' },
  { serialized: 'primary+n', reason: 'New window (WebView2)' },
  { serialized: 'primary+r', reason: 'Reload (WebView2)' },
  { serialized: 'primary+shift+r', reason: 'Hard reload (WebView2)' },
  { serialized: 'primary+shift+i', reason: 'DevTools (WebView2)' },
  { serialized: 'primary+shift+j', reason: 'DevTools console (WebView2)' },
  { serialized: 'primary+shift+c', reason: 'Inspect element (WebView2)' },
  { serialized: 'f5', reason: 'Reload' },
  { serialized: 'f11', reason: 'Fullscreen (window manager)' },
  { serialized: 'f12', reason: 'DevTools (WebView2)' },
  { serialized: 'ctrl+alt+delete', reason: 'Reserved by Windows' },
  { serialized: 'ctrl+shift+escape', reason: 'Reserved by Windows (Task Manager)' },
  { serialized: 'alt+f4', reason: 'Reserved by Windows (close window)' },
  { serialized: 'alt+space', reason: 'Reserved by Windows (window menu)' },
];

/**
 * The reason a sequence is platform-reserved, or `null` when it is bindable.
 * TOTAL: an empty or unrepresentable sequence is never reserved.
 */
export function reservedReason(seq: KeySequence, platform?: Platform): string | null {
  if (!seq || seq.length === 0) return null;
  for (const combo of PLATFORM_RESERVED_COMBOS) {
    const parsed = parseSequence(combo.serialized);
    if (parsed.length === 0) continue;
    if (sequenceEquals(seq, parsed, platform)) return combo.reason;
  }
  return null;
}
