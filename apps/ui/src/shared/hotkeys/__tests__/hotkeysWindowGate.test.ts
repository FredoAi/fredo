/**
 * Spec #3007 ST-2 — the PURE window gate for the resting hotkeys cluster
 * (`hotkeysWindowGate.ts`).
 *
 * Pins the binding contract: `isHotkeysClusterSuppressed(search?)` is true IFF
 * `view=doom`; every other window (a different `view`, no query) is
 * un-suppressed. Defaults to the live `window.location.search`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOTKEYS_CLUSTER_SUPPRESSED_VIEW_PARAM,
  HOTKEYS_CLUSTER_SUPPRESSED_VIEW_VALUE,
  isHotkeysClusterSuppressed,
} from '../hotkeysWindowGate';

/** Point jsdom's URL at a given query string (the gate defaults to location.search). */
function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

afterEach(() => {
  setSearch('');
});

describe('hotkeysWindowGate constants', () => {
  it('exposes the binding param/value names verbatim', () => {
    expect(HOTKEYS_CLUSTER_SUPPRESSED_VIEW_PARAM).toBe('view');
    expect(HOTKEYS_CLUSTER_SUPPRESSED_VIEW_VALUE).toBe('doom');
  });
});

describe('isHotkeysClusterSuppressed', () => {
  it('suppresses when the view param is exactly `doom`', () => {
    expect(isHotkeysClusterSuppressed('?view=doom')).toBe(true);
    // Extra params do not defeat the gate.
    expect(isHotkeysClusterSuppressed('?foo=1&view=doom&bar=2')).toBe(true);
    // No leading `?` is also a valid query string.
    expect(isHotkeysClusterSuppressed('view=doom')).toBe(true);
  });

  it('does not suppress for any other view', () => {
    expect(isHotkeysClusterSuppressed('?view=terminal')).toBe(false);
    expect(isHotkeysClusterSuppressed('?view=app&id=mission-monitor')).toBe(false);
    // Case-sensitive and whitespace-sensitive: exactly `doom`.
    expect(isHotkeysClusterSuppressed('?view=Doom')).toBe(false);
    expect(isHotkeysClusterSuppressed('?view=doomsday')).toBe(false);
  });

  it('does not suppress when the query is absent or the view param is missing', () => {
    expect(isHotkeysClusterSuppressed('')).toBe(false);
    expect(isHotkeysClusterSuppressed('?')).toBe(false);
    expect(isHotkeysClusterSuppressed('?other=value')).toBe(false);
  });

  it('defaults to window.location.search', () => {
    setSearch('?view=doom');
    expect(isHotkeysClusterSuppressed()).toBe(true);

    setSearch('?view=terminal');
    expect(isHotkeysClusterSuppressed()).toBe(false);

    setSearch('');
    expect(isHotkeysClusterSuppressed()).toBe(false);
  });
});
