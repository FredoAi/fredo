/**
 * Spec #3118 (P4), ST-5 — the announcement channel and its binding message composers.
 *
 * R-4.1 … R-4.6: exactly ONE polite live region, one message per event class, and the
 * migration shape (`channel: 'legacy'`) that ADOPTS the shipped `hotkeys` region instead
 * of adding a second one. `shared/hotkeys/` is imported, never edited (P4 purity boundary).
 *
 * The message strings below are the binding names block (`## Software Architect` §4). Every
 * surface announces THROUGH these composers — no call site formats its own sentence — so the
 * QA rows (`Q4-01…Q4-04`) and the recorded screen-reader pass (§11.4) assert one text.
 *
 * Store contract: a module-scoped string + subscriber set, exactly like the legacy
 * `announcer.tsx`. Identical consecutive text deduplicates to ONE notification (the shipped
 * `announce()` rule), so a re-entered place never speaks twice.
 */

import React, { useEffect, useSyncExternalStore } from 'react';
import { VisuallyHidden } from '@chakra-ui/react';

import { NOTHING_TO_UNDO } from '../types';
import { announce } from '../../hotkeys/announcer';
import { NAV_ANNOUNCER_LABEL, NAV_ANNOUNCER_TESTID } from './constants';

/* ───────────────────────────── channels ───────────────────────────── */

/** R-4.6 — the two mutually exclusive announcement channels of the migration. */
export type AnnouncementChannel = 'navigation' | 'legacy';

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

/* ───────────────────────────── the channel store ───────────────────────────── */

/** The active channel. `'navigation'` renders its own region; `'legacy'` forwards. */
let channel: AnnouncementChannel = 'navigation';

/** The single current navigation announcement. */
let announcement = '';

/** Module-scoped subscribers (React's `useSyncExternalStore` contract). */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** R-4.6 — choose the channel. A migrated app passes `'legacy'` until P5 settles ownership. */
export function configureNavigationAnnouncer(options: {
  readonly channel: AnnouncementChannel;
}): void {
  channel = options.channel;
}

/**
 * Emit one navigation announcement.
 *
 * `channel: 'legacy'` forwards to the shipped `announce()` (the single `hotkeys-announcer`
 * region) and the navigation component renders NOTHING — so the migration shape keeps
 * exactly one polite live region (R-4.6). Identical consecutive text is one update.
 */
export function announceNavigation(message: string): void {
  const next = typeof message === 'string' ? message : '';
  if (channel === 'legacy') announce(next);
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

/** Reset the channel — test hygiene only (the store is module-scoped). */
export function resetNavigationAnnouncer(): void {
  channel = 'navigation';
  if (announcement === '') return;
  announcement = '';
  notify();
}

/** R-4.6 — test-only truth: how many polite live regions are currently in the document. */
export function countActiveLiveRegions(): number {
  return document.querySelectorAll('[aria-live]').length;
}

/* ───────────────────────────── the component ───────────────────────────── */

export interface NavigationAnnouncerProps {
  readonly channel?: AnnouncementChannel;
}

/**
 * The ONE navigation live region (R-4.6).
 *
 * Default (`'navigation'`): renders exactly one `role="status" aria-live="polite"` node, the
 * bound test id and accessible name. `'legacy'`: renders nothing and points the store at the
 * shipped `announce()` channel, so the already-mounted `HotkeyAnnouncer` is the only region.
 */
export function NavigationAnnouncer({
  channel: channelProp = 'navigation',
}: NavigationAnnouncerProps): React.ReactElement | null {
  const text = useSyncExternalStore(
    subscribeNavigationAnnouncement,
    getNavigationAnnouncement,
    getNavigationAnnouncement,
  );

  // Configure the module channel when the mounted announcer says which one owns the region.
  useEffect(() => {
    configureNavigationAnnouncer({ channel: channelProp });
  }, [channelProp]);

  if (channelProp !== 'navigation') return null;

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
