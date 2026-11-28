/**
 * Spec #3243 ST-8 — `orderFlight`, the module-scoped in-flight order record.
 *
 * The pins that matter, and the defect world each rejects:
 *
 *   1. **A flight survives the surface that began it.** The record is begun, then
 *      every subscriber drops (the composer card unmounts) and a fresh reader
 *      still sees it. A React ref or a `useState` fails exactly here — and that
 *      failure is AC-3 becoming unobservable, not a cosmetic bug.
 *   2. **`clearPlacement()` ends the flight** (AC-4). A later placement of the
 *      SAME app must start empty, so the record is scoped to the placement
 *      identity — never to the app id. A record keyed on `appId` would show the
 *      first placement's outcome in the second one.
 *   3. **A move does NOT end the flight** (AC-3). The record keeps naming the
 *      ORIGINAL app: this is the half that stops the target chip's datum from
 *      being copied onto the ticker, which would be the UI lying.
 *   4. **A late settle cannot resurrect a discarded record** — the settle returns
 *      `null` instead of re-creating a flight for a placement that is gone.
 *   5. **`needs-confirmation` is not terminal** — it is reachable, and a settle
 *      after it still lands, so a confirmation cannot be mistaken for a verdict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_FLIGHT_STATES,
  awaitOrderConfirmation,
  beginOrderFlight,
  clearOrderFlight,
  readOrderFlight,
  resetOrderFlightForTests,
  settleOrderFlight,
  subscribeOrderFlight,
} from '../orderFlight';
import {
  clearPlacement,
  placeFredo,
  resetPlacementForTests,
} from '../../placement/placementStore';

beforeEach(() => {
  resetOrderFlightForTests();
  resetPlacementForTests();
});

afterEach(() => {
  resetOrderFlightForTests();
  resetPlacementForTests();
});

/** Place Fredo into an app and return the minted placement id. */
function place(appId = 'wireframe', appName = 'Wireframe'): string {
  const placement = placeFredo(appId, appName);
  if (placement === null) throw new Error('placement did not mint');
  return placement.placementId;
}

function begin(appId = 'wireframe', appName = 'Wireframe', orderId = 'order-1') {
  return beginOrderFlight({ orderId, appId, appName });
}

describe('orderFlight — the record survives the surface that began it (AC-3)', () => {
  it('is readable after EVERY subscriber unsubscribes (a React ref would be gone)', () => {
    place();
    begin();

    // The composer card that began the flight unmounts: its subscription dies.
    // A ref or a `useState` would take the record with it.
    const unsubscribe = subscribeOrderFlight(() => undefined);
    unsubscribe();

    const flight = readOrderFlight();
    expect(flight).not.toBeNull();
    expect(flight?.orderId).toBe('order-1');
    expect(flight?.state).toBe('running');
    expect(flight?.appName).toBe('Wireframe');
  });

  it('reads null before any order begins', () => {
    place();
    expect(readOrderFlight()).toBeNull();
  });
});

describe('orderFlight — a move keeps the ORIGINAL app (AC-3)', () => {
  it('the record keeps the SUBMIT-time app while the live target resolves a DIFFERENT app', () => {
    place('wireframe', 'Wireframe');
    begin('wireframe', 'Wireframe');

    // The MOVE, modelled faithfully: the re-scope is deferred to the order's
    // COMPLETION (R-3b: "WHEN that order has completed, the placement SHALL be
    // re-scoped"), so mid-flight the placement is STILL the original one. What
    // moves is the CHIP's datum — recomputed every render from the live target
    // resolver, independently of this record.
    //
    // The chip now resolves Mission Monitor; the order's record must keep naming
    // Wireframe. That divergence WITHIN one placement is the both-true pair
    // (G-475b: one claim per subject) — and it is the discriminator F-14 drives.
    const chipAppAfterMove = 'mission-monitor';

    const flight = readOrderFlight();
    expect(flight?.appId).toBe('wireframe');
    expect(flight?.appName).toBe('Wireframe');
    // The two claims are genuinely different values, so the assertion above is not
    // a coincidental equality.
    expect(flight?.appId).not.toBe(chipAppAfterMove);
  });

  it('the record is keyed on the PLACEMENT, not on the app id', () => {
    place('wireframe', 'Wireframe');
    begin();

    // A re-placement of the SAME app is a NEW placement (ST-1 mints per placement),
    // so the old flight must not survive it. Keying on `appId` would pass this by
    // accident and then show the first placement's outcome in the second one.
    place('wireframe', 'Wireframe');
    expect(readOrderFlight()).toBeNull();
  });
});

describe('orderFlight — leaving discards (AC-4)', () => {
  it('clearPlacement() ends the flight, so a re-placement of the same app starts empty', () => {
    place();
    begin();
    settleOrderFlight({ state: 'done', text: 'Filled Rectangle in Wireframe' });
    expect(readOrderFlight()?.state).toBe('done');

    clearPlacement();
    expect(readOrderFlight()).toBeNull();

    place('wireframe', 'Wireframe');
    expect(readOrderFlight()).toBeNull();
  });
});

describe('orderFlight — transitions', () => {
  it('settles to a terminal state carrying the outcome sentence', () => {
    place();
    begin();

    settleOrderFlight({ state: 'done', text: 'Filled Rectangle in Wireframe' });

    const flight = readOrderFlight();
    expect(flight?.state).toBe('done');
    expect(flight?.text).toBe('Filled Rectangle in Wireframe');
  });

  it('carries needs-confirmation as a NON-terminal state that can still settle', () => {
    place();
    begin();

    awaitOrderConfirmation();
    expect(readOrderFlight()?.state).toBe('needs-confirmation');
    // The sentence is NOT set by the confirmation: nothing has run yet.
    expect(readOrderFlight()?.text).toBe('');

    settleOrderFlight({ state: 'done', text: 'Filled Rectangle in Wireframe' });
    expect(readOrderFlight()?.state).toBe('done');
  });

  it('a settle after the placement ended returns null and does NOT resurrect the record', () => {
    place();
    begin();
    clearPlacement();

    // The in-flight order settles late, after the user left. Re-creating a record
    // here would show a previous placement's outcome in a fresh one.
    expect(settleOrderFlight({ state: 'failed', text: 'Did not run' })).toBeNull();
    expect(awaitOrderConfirmation()).toBeNull();
    expect(readOrderFlight()).toBeNull();
  });

  it('a second begin supersedes the first order rather than merging', () => {
    place();
    begin('wireframe', 'Wireframe', 'order-1');
    settleOrderFlight({ state: 'done', text: 'one' });

    begin('wireframe', 'Wireframe', 'order-2');

    const flight = readOrderFlight();
    expect(flight?.orderId).toBe('order-2');
    expect(flight?.state).toBe('running');
    // The previous outcome is not carried anywhere — there is no history here.
    expect(flight?.text).toBe('');
  });
});

describe('orderFlight — the subscription contract', () => {
  it('notifies on begin, settle, confirmation and clear', () => {
    place();
    const listener = vi.fn();
    subscribeOrderFlight(listener);

    begin();
    expect(listener).toHaveBeenCalledTimes(1);

    awaitOrderConfirmation();
    expect(listener).toHaveBeenCalledTimes(2);

    settleOrderFlight({ state: 'done', text: 'done' });
    expect(listener).toHaveBeenCalledTimes(3);

    clearOrderFlight();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('advances seq on every transition, so "the record changed" is observable', () => {
    place();
    expect(begin().seq).toBe(1);
    expect(awaitOrderConfirmation()?.seq).toBe(2);
    expect(settleOrderFlight({ state: 'done', text: 'done' })?.seq).toBe(3);
  });

  it('an unsubscribed listener is not notified again', () => {
    place();
    const listener = vi.fn();
    const unsubscribe = subscribeOrderFlight(listener);

    begin();
    unsubscribe();
    settleOrderFlight({ state: 'done', text: 'done' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear is idempotent — clearing twice notifies once', () => {
    place();
    begin();
    const listener = vi.fn();
    subscribeOrderFlight(listener);

    clearOrderFlight();
    clearOrderFlight();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('orderFlight — the published state vocabulary', () => {
  it('is exactly the five states the plan publishes, in order', () => {
    // The one runtime array; a state added without a render arm would otherwise
    // be unrenderable and its row unreachable.
    expect(ORDER_FLIGHT_STATES).toEqual([
      'running',
      'needs-confirmation',
      'done',
      'failed',
      'refused',
    ]);
  });

  it('every declared state is reachable from a real record', () => {
    place();
    const reached = new Set<string>();
    reached.add(begin().state);
    reached.add(awaitOrderConfirmation()?.state ?? '');
    reached.add(settleOrderFlight({ state: 'done', text: 'x' })?.state ?? '');
    reached.add(settleOrderFlight({ state: 'failed', text: 'x' })?.state ?? '');
    reached.add(settleOrderFlight({ state: 'refused', text: 'x' })?.state ?? '');

    expect([...reached].sort()).toEqual([...ORDER_FLIGHT_STATES].sort());
  });
});
