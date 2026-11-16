/**
 * Spec #3119 (retry, ST-F1/ST-F1a), re-homed by Spec #3120 (P6 rescope, ST-5) — place-transition
 * focus retention for `CommandRail`.
 *
 * A place transition replaces the bar's verb cluster (a different place declares a different
 * set of verbs), so a keyboard user standing on a verb row may lose the focused node: the
 * browser drops `document.activeElement` to `document.body`, and because the shell's ONE key
 * adapter is element-scoped on `wireframe-root`, every later stroke goes dead until the user
 * clicks back in.
 *
 * The bar OWNS that unmount, so the bar re-homes the focus it dropped — and nothing else:
 *
 *   1. `onFocus` on the bar root records the last in-bar control the USER focused
 *      (React uses `focusin`, which bubbles — no `document`/`window` listener).
 *   2. A `useLayoutEffect` keyed on the place path (the component-visible projection of the
 *      host's epoch/placePath commit) fires AFTER the DOM mutation that removed the node.
 *   3. On mount it records the baseline only — never a focus move (the bar's contract).
 *   4. When the transition DROPPED a bar-owned focus (the tracked node is `!isConnected`
 *      AND `document.activeElement` is `body`/null) it re-focuses the same control if it is
 *      still rendered, else the LAST BREADCRUMB SEGMENT — `navigation-bar-place`
 *      (`tabIndex={-1}`, `aria-current="page"`, UIUX-D4) — and remembers the lost control as
 *      the round-trip target.
 *   5. When focus is still exactly where the bar put it and the remembered control is back
 *      (the `Escape` round trip), focus returns to it.
 *
 * Focus the user moved elsewhere (canvas, property panel, map dialog, another control) is
 * never touched. The hook writes refs only — no state write that could re-render the bar —
 * and adds no prop, no timer and no `document` listener.
 */

import React from 'react';

import { NAV_RAIL_PLACE_TESTID } from './constants';
import type { CommandRailModel } from './types';

/** The attributes that identify one rail control across a re-render. */
interface RailFocusOwner {
  readonly testId: string | null;
  readonly navAttr: 'data-nav-place-id' | 'data-nav-verb-id' | null;
  readonly navValue: string | null;
}

/** What `CommandRail` binds onto its root element. */
export interface PlaceTransitionFocusBinding {
  readonly railRef: React.RefObject<HTMLDivElement | null>;
  readonly onFocus: React.FocusEventHandler<HTMLDivElement>;
}

/** Read the re-resolvable identity of a focused control (`data-testid` + one nav attribute). */
function readOwner(element: HTMLElement): RailFocusOwner {
  const testId = element.getAttribute('data-testid');
  const placeId = element.getAttribute('data-nav-place-id');
  if (placeId !== null) {
    return { testId, navAttr: 'data-nav-place-id', navValue: placeId };
  }
  const verbId = element.getAttribute('data-nav-verb-id');
  if (verbId !== null) {
    return { testId, navAttr: 'data-nav-verb-id', navValue: verbId };
  }
  return { testId, navAttr: null, navValue: null };
}

/**
 * Find the control an owner names inside the rail. Attribute comparison (never a CSS
 * selector): place ids contain `.` and a declaration id must never need escaping.
 */
function findOwner(root: HTMLElement, owner: RailFocusOwner): HTMLElement | null {
  if (owner.testId === null) return null;
  for (const candidate of Array.from(root.querySelectorAll<HTMLElement>('[data-testid]'))) {
    if (candidate.getAttribute('data-testid') !== owner.testId) continue;
    if (owner.navAttr === null) return candidate;
    if (candidate.getAttribute(owner.navAttr) === owner.navValue) return candidate;
  }
  return null;
}

/** `true` when the browser fell back to the document body (or has no focused element). */
function focusFellToBody(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * Keep a keyboard user inside the rail across a place transition. Returns the ref + handler
 * `CommandRail` binds on its root; no prop is added to the component surface.
 */
export function usePlaceTransitionFocus(model: CommandRailModel): PlaceTransitionFocusBinding {
  const railRef = React.useRef<HTMLDivElement | null>(null);
  /** The in-rail control the USER focused last (recorded from the bubbling `focusin`). */
  const ownerRef = React.useRef<{ owner: RailFocusOwner; element: HTMLElement } | null>(null);
  /** The lost control the rail must return to once it renders again (`Escape` round trip). */
  const returnTargetRef = React.useRef<RailFocusOwner | null>(null);
  /** The element the rail itself focused — the `placedByRail` marker (never a user focus). */
  const placedByRailRef = React.useRef<HTMLElement | null>(null);
  /** The previous place path; `null` until the first committed render. */
  const lastPathRef = React.useRef<string | null>(null);

  // The component-visible projection of the host's placePath/epoch change (`host.ts`).
  const pathKey =
    model.breadcrumb.length > 0
      ? model.breadcrumb.map((place) => place.id).join('>')
      : model.currentPlace.id;

  const onFocus = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Our own programmatic move is not a user focus: keep the tracked owner + return target.
    if (target === placedByRailRef.current) return;
    // A user focus inside the rail re-seats the owner and cancels any pending round trip.
    placedByRailRef.current = null;
    returnTargetRef.current = null;
    ownerRef.current = { owner: readOwner(target), element: target };
  }, []);

  React.useLayoutEffect(() => {
    const previousPath = lastPathRef.current;
    lastPathRef.current = pathKey;
    // First committed render (or a render that did not move the place): record only.
    if (previousPath === null || previousPath === pathKey) return;

    const root = railRef.current;
    if (root === null) return;

    const placedByRail = placedByRailRef.current;
    const returnTarget = returnTargetRef.current;

    // Round trip: focus is still where the rail put it and the named control is back.
    if (
      placedByRail !== null &&
      document.activeElement === placedByRail &&
      returnTarget !== null
    ) {
      const restored = findOwner(root, returnTarget);
      if (restored !== null) {
        ownerRef.current = { owner: returnTarget, element: restored };
        returnTargetRef.current = null;
        placedByRailRef.current = restored;
        restored.focus({ preventScroll: true });
        return;
      }
    }

    // Re-home ONLY a focus the transition dropped: the tracked control is gone AND the
    // browser fell back to `body`/null. Focus the user moved elsewhere is never touched.
    const tracked = ownerRef.current;
    if (tracked === null || tracked.element.isConnected || !focusFellToBody()) return;

    const sameControl = findOwner(root, tracked.owner);
    if (sameControl !== null) {
      ownerRef.current = { owner: tracked.owner, element: sameControl };
      returnTargetRef.current = null;
      placedByRailRef.current = sameControl;
      sameControl.focus({ preventScroll: true });
      return;
    }

    // The stable anchor: the current-place breadcrumb segment is always rendered
    // (`tabIndex={-1}`, `aria-current="page"`, UIUX-D4).
    const anchor = findOwner(root, {
      testId: NAV_RAIL_PLACE_TESTID,
      navAttr: null,
      navValue: null,
    });
    if (anchor === null) return;
    returnTargetRef.current = tracked.owner;
    placedByRailRef.current = anchor;
    anchor.focus({ preventScroll: true });
  }, [pathKey]);

  return { railRef, onFocus };
}
