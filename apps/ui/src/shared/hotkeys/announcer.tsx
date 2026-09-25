/**
 * Spec #2946 ST-3 — the ONE polite announcement channel (R-3.2).
 *
 * Every hotkey announcement (sequence help R-1.3, the one-time terminal
 * passthrough notice R-5.8 owned by ST-12, cheat-sheet open, macro record/replay)
 * goes through this single module-scoped `role="status" aria-live="polite"`
 * region. Visual surfaces MUST NOT declare per-item live regions — they mark
 * their visuals `aria-hidden` and call `announce(text)`.
 *
 * The region is mounted exactly once by the app shell (`<HotkeyAnnouncer />`).
 * `announce` is imperative so non-React paths (the dispatch engine, passthrough
 * detection) can emit without a hook; `useHotkeyAnnouncer` is the subscribe hook
 * the announcer (and any read-only consumer) uses.
 */

import React, { useSyncExternalStore } from 'react';
import { VisuallyHidden } from '@chakra-ui/react';

/** The fixed accessible name of the shared help channel (UI/UX §1 / H-26). */
export const HOTKEY_ANNOUNCER_LABEL = 'Hotkey sequence help';

/** The single current announcement. */
let announcement = '';

/** Module-scoped subscribers (React's useSyncExternalStore contract). */
const listeners = new Set<() => void>();

/** The current announcement — a stable string snapshot for useSyncExternalStore. */
export function getAnnouncement(): string {
  return announcement;
}

/** Subscribe to announcement changes; returns the unsubscribe handle. */
export function subscribeAnnouncer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Emit one polite announcement through the single shared channel. */
export function announce(text: string): void {
  const next = typeof text === 'string' ? text : '';
  if (next === announcement) return;
  announcement = next;
  for (const listener of listeners) listener();
}

/** Reset the channel — test hygiene only (the store is module-scoped). */
export function resetHotkeyAnnouncer(): void {
  if (announcement === '') return;
  announcement = '';
  for (const listener of listeners) listener();
}

/** Subscribe a component to the current announcement. */
export function useHotkeyAnnouncer(): string {
  return useSyncExternalStore(subscribeAnnouncer, getAnnouncement, getAnnouncement);
}

/** The single, once-mounted live region. Render it once in the app shell. */
export function HotkeyAnnouncer() {
  const text = useHotkeyAnnouncer();
  return (
    <VisuallyHidden
      data-testid="hotkeys-announcer"
      role="status"
      aria-live="polite"
      aria-label={HOTKEY_ANNOUNCER_LABEL}
    >
      {text}
    </VisuallyHidden>
  );
}
