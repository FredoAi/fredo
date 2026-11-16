/**
 * Spec #3118 (P4), ST-5 — the announcement channel and its binding message composers;
 * Spec #3122 (P8), ST-2 — the ONE single channel (the migration `legacy` branch is retired).
 *
 * R-4.1 … R-4.6: exactly ONE polite live region, one message per event class. The navigation
 * layer now OWNS that region (`NavigationProvider` renders the ONE `<NavigationAnnouncer />`);
 * there is no forwarding channel and no second announcer.
 *
 * The message strings below are the binding names block (`## Software Architect` §4). Every
 * surface announces THROUGH these composers — no call site formats its own sentence — so the
 * QA rows (`Q4-01…Q4-04`) and the recorded screen-reader pass (§11.4) assert one text.
 *
 * Store contract: a module-scoped string + subscriber set. Identical consecutive text
 * deduplicates to ONE notification, so a re-entered place never speaks twice.
 */

import React, { useSyncExternalStore } from 'react';
import { VisuallyHidden } from '@chakra-ui/react';

import { NOTHING_TO_UNDO } from '../types';
import { NAV_ANNOUNCER_LABEL, NAV_ANNOUNCER_TESTID } from './constants';

/* ───────────────────────────── composers (R-4.1 … R-4.4) ───────────────────────────── */

/** R-4.1 — a place was entered (or switched to): name + action count. */
export function navPlaceEnterMessage(label: string, actionCount: number): string {
  return `${label} — ${actionCount} action${actionCount === 1 ? '' : 's'}`;
}

/** R-4.1 — a level was popped: the exited place, the new place and its action count. */
export function navPlaceExitMessage(
  leftLabel: string,
  label: string,
  actionCount: number,
): string {
  return `Left ${leftLabel} — ${label} — ${actionCount} action${actionCount === 1 ? '' : 's'}`;
}

/** R-4.2 — an armed prefix and its continuation labels (`'w…'` when there are none). */
export function navPrefixMessage(prefix: string, labels: readonly string[]): string {
  return labels.length > 0 ? `${prefix}… ${labels.join(', ')}` : `${prefix}…`;
}

/** R-4.3 — tier-4 no-match: the stroke is not bound here. */
export function navUnavailableKeyMessage(key: string): string {
  return `${key} isn't available here`;
}

/** R-4.3 — one stroke resolves to more than one target. */
export function navAmbiguousKeyMessage(key: string): string {
  return `${key} matches more than one action`;
}

/** R-4.4 — an undo succeeded. */
export function navUndoMessage(label: string): string {
  return `Undid ${label}`;
}

/** R-4.4 — an undo found nothing; the ONE shipped empty-undo sentence. */
export function navUndoNothingMessage(): string {
  return NOTHING_TO_UNDO;
}

/** R-4.4 — an undo failed while applying its inverse. */
export function navUndoFailedMessage(label: string): string {
  return `Couldn't undo ${label}`;
}

/* ───────────────────────────── the single channel store ───────────────────────────── */

/** The single current navigation announcement. */
let announcement = '';

/** Module-scoped subscribers (React's `useSyncExternalStore` contract). */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Emit one navigation announcement to the ONE navigation live region. Identical consecutive
 * text is one update.
 */
export function announceNavigation(message: string): void {
  const next = typeof message === 'string' ? message : '';
  if (next === announcement) return;
  announcement = next;
  notify();
}

/** The current announcement — a stable string snapshot for `useSyncExternalStore`. */
export function getNavigationAnnouncement(): string {
  return announcement;
}

/** Subscribe to announcement changes; returns the unsubscribe handle. */
export function subscribeNavigationAnnouncement(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset the announcement — test hygiene only (the store is module-scoped). */
export function resetNavigationAnnouncer(): void {
  if (announcement === '') return;
  announcement = '';
  notify();
}

/** R-4.6 — test-only truth: how many polite live regions are currently in the document. */
export function countActiveLiveRegions(): number {
  return document.querySelectorAll('[aria-live]').length;
}

/* ───────────────────────────── the component ───────────────────────────── */

/**
 * The ONE navigation live region (R-4.6). Mounted exactly once per webview by
 * `NavigationProvider`; a second mount is a documented defect signal, never silently deduped.
 */
export function NavigationAnnouncer(): React.ReactElement {
  const text = useSyncExternalStore(
    subscribeNavigationAnnouncement,
    getNavigationAnnouncement,
    getNavigationAnnouncement,
  );

  return (
    <VisuallyHidden
      data-testid={NAV_ANNOUNCER_TESTID}
      role="status"
      aria-live="polite"
      aria-label={NAV_ANNOUNCER_LABEL}
    >
      {text}
    </VisuallyHidden>
  );
}
