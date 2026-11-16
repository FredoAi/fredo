/**
 * Spec #3118 (P4), ST-5 — the announcement channel's unit pins (QA Q4-01…Q4-04).
 *
 * Every message is asserted against the BOUND composer named by the plan, never a
 * hand-written sentence, so the surface call sites and the recorded screen-reader pass
 * (§11.4) all speak one text. The store contract is the shipped `announcer.tsx` contract:
 * one notification per DISTINCT message (identical consecutive text deduplicates).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { NOTHING_TO_UNDO } from '../../types';
import {
  NavigationAnnouncer,
  announceNavigation,
  countActiveLiveRegions,
  getNavigationAnnouncement,
  navAmbiguousKeyMessage,
  navPlaceEnterMessage,
  navPlaceExitMessage,
  navPrefixMessage,
  navUndoFailedMessage,
  navUndoMessage,
  navUndoNothingMessage,
  navUnavailableKeyMessage,
  resetNavigationAnnouncer,
  subscribeNavigationAnnouncement,
} from '../announce';
import { NAV_ANNOUNCER_LABEL, NAV_ANNOUNCER_TESTID } from '../constants';

beforeEach(() => {
  resetNavigationAnnouncer();
});

afterEach(() => {
  cleanup();
  resetNavigationAnnouncer();
});

/* ───────────────────────── composers (Q4-01 … Q4-04) ───────────────────────── */

describe('the bound message composers (R-4.1 … R-4.4)', () => {
  it('Q4-01 place enter: name + action count, with the singular/zero forms', () => {
    expect(navPlaceEnterMessage('Editing', 5)).toBe('Editing — 5 actions');
    expect(navPlaceEnterMessage('Editing', 1)).toBe('Editing — 1 action');
    expect(navPlaceEnterMessage('Editing', 0)).toBe('Editing — 0 actions');
  });

  it('Q4-01 place exit: the exited place, the new place and its action count', () => {
    expect(navPlaceExitMessage('Canvas', 'Editing', 5)).toBe('Left Canvas — Editing — 5 actions');
    expect(navPlaceExitMessage('Canvas', 'Editing', 1)).toBe('Left Canvas — Editing — 1 action');
    expect(navPlaceExitMessage('Canvas', 'Editing', 0)).toBe('Left Canvas — Editing — 0 actions');
  });

  it('Q4-02 prefix: the armed prefix and its continuation labels', () => {
    expect(navPrefixMessage('w', ['Focus next', 'Focus previous'])).toBe(
      'w… Focus next, Focus previous',
    );
    expect(navPrefixMessage('w', ['Focus next'])).toBe('w… Focus next');
    expect(navPrefixMessage('w', [])).toBe('w…');
  });

  it('Q4-03 unresolvable and ambiguous keys are two distinct sentences', () => {
    expect(navUnavailableKeyMessage('z')).toBe("z isn't available here");
    expect(navAmbiguousKeyMessage('x')).toBe('x matches more than one action');
    expect(navUnavailableKeyMessage('z')).not.toBe(navAmbiguousKeyMessage('z'));
  });

  it('Q4-04 undo success / nothing / failure', () => {
    expect(navUndoMessage('Rectangle')).toBe('Undid Rectangle');
    expect(navUndoNothingMessage()).toBe(NOTHING_TO_UNDO);
    expect(navUndoNothingMessage()).toBe('Nothing to undo.');
    expect(navUndoFailedMessage('Rectangle')).toBe("Couldn't undo Rectangle");
  });
});

/* ───────────────────────── the store ───────────────────────── */

describe('the navigation announcement store', () => {
  it('notifies exactly once per distinct message and exposes the current text', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeNavigationAnnouncement(() => seen.push(getNavigationAnnouncement()));

    announceNavigation('Editing — 5 actions');
    announceNavigation('Editing — 5 actions'); // identical consecutive text deduplicates
    announceNavigation('Left Canvas — Editing — 3 actions');

    expect(seen).toEqual(['Editing — 5 actions', 'Left Canvas — Editing — 3 actions']);
    expect(getNavigationAnnouncement()).toBe('Left Canvas — Editing — 3 actions');

    unsubscribe();
    announceNavigation('after unsubscribe');
    expect(seen).toHaveLength(2);
  });

  it('resetNavigationAnnouncer() clears the channel (test hygiene)', () => {
    announceNavigation('Undid Rectangle');
    expect(getNavigationAnnouncement()).toBe('Undid Rectangle');

    resetNavigationAnnouncer();
    expect(getNavigationAnnouncement()).toBe('');
  });
});

/* ───────────────────────── the region ───────────────────────── */

describe('NavigationAnnouncer — the ONE navigation live region (R-4.6)', () => {
  it('renders exactly one polite status region with the bound hooks', () => {
    const { getByTestId } = renderWithChakra(<NavigationAnnouncer />);

    const region = getByTestId(NAV_ANNOUNCER_TESTID);
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-label', NAV_ANNOUNCER_LABEL);
    expect(region).toHaveTextContent('');
    expect(countActiveLiveRegions()).toBe(1);
  });

  it('drives the region from announceNavigation and speaks one update per class', () => {
    const { getByTestId } = renderWithChakra(<NavigationAnnouncer />);
    const region = getByTestId(NAV_ANNOUNCER_TESTID);

    act(() => announceNavigation(navPlaceEnterMessage('Editing', 5)));
    expect(region).toHaveTextContent('Editing — 5 actions');

    act(() => announceNavigation(navPlaceExitMessage('Canvas', 'Editing', 3)));
    expect(region).toHaveTextContent('Left Canvas — Editing — 3 actions');
    expect(region).not.toHaveTextContent('Editing — 5 actions');

    act(() => announceNavigation(navUndoMessage('Rectangle')));
    expect(region).toHaveTextContent('Undid Rectangle');
  });
});
