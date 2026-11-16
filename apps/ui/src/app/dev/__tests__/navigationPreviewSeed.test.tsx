/**
 * Spec #3118 (P4), ST-6c — Q8-01: the demo seeds exactly ONE companion entry.
 *
 * The app root mounts under `React.StrictMode` (`apps/ui/src/main.tsx`), so in dev every
 * mount effect is invoked twice on the SAME component instance (mount → cleanup → mount).
 * The seed effect is guarded by a SYNCHRONOUS one-shot latch keyed to the host instance,
 * because `host.runVerb` awaits `dispatch` before the journal entry is appended — a snapshot
 * read (`entries.length === 0`) loses the race and enqueues a second companion entry.
 *
 * This suite is the reproduction the round-1 static leg could not see: it renders the real
 * `NavigationPreview` inside `React.StrictMode` and asserts the count AFTER the pending
 * dispatches have flushed (never inside a `waitFor`, which could pass on the transient 1).
 * The second case is the non-vacuity control: the same render WITHOUT StrictMode also yields
 * exactly one, proving the assertion is not trivially true and that the latch does not
 * suppress a real seed.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

import { NavigationPreview } from '../NavigationPreview';
import { resetNavigationDemoState } from '../navigationDemoSurface';
import { resetNavigationAnnouncer } from '@/shared/navigation/ui/announce';
import { NAV_ACTOR_ATTR, NAV_TRAIL_ENTRY_TESTID } from '@/shared/navigation/ui/constants';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

/**
 * Flush the seed's async chain (`runVerb` awaits `dispatch` before the append lands). Two
 * macrotask turns drain both the StrictMode double-invoke and the awaited dispatch.
 */
async function flushSeed(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  resetNavigationDemoState();
  resetNavigationAnnouncer();
});

afterEach(() => {
  cleanup();
  resetNavigationDemoState();
  resetNavigationAnnouncer();
});

describe('Q8-01 — the demo seeds exactly ONE companion entry (R-8.1)', () => {
  it('seeds one companion entry under React.StrictMode (double-effect)', async () => {
    renderWithChakra(
      <React.StrictMode>
        <NavigationPreview />
      </React.StrictMode>,
    );

    await screen.findAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    await flushSeed();

    const rows = screen.queryAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute(NAV_ACTOR_ATTR, 'companion');
    expect(rows[0]).toHaveTextContent('Rectangle');
  });

  it('seeds one companion entry without StrictMode (non-vacuity control)', async () => {
    renderWithChakra(<NavigationPreview />);

    await screen.findAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    await flushSeed();

    const rows = screen.queryAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute(NAV_ACTOR_ATTR, 'companion');
    expect(rows[0]).toHaveTextContent('Rectangle');
  });
});
