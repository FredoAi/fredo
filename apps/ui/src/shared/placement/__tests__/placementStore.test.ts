/**
 * Spec #3243 ST-1 — the placement lifecycle (R-4a / R-4b).
 *
 * The pins below are the plan's own, restated with the DEFECT WORLD each must
 * reject (G-520):
 *
 *   - "a second placement mints a NEW identity" must assert **id inequality
 *     across eagerly-minted ids**, never "the store has one entry" — a store
 *     that reuses one id per app would pass the weaker reading while AC-4 is
 *     broken;
 *   - "clear discards" must assert the store is EMPTY (a later placement of the
 *     SAME app is fresh), not merely that a subscriber was told something.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPlacement,
  placeFredo,
  readPlacement,
  rescopePlacement,
  resetPlacementForTests,
  subscribePlacement,
} from '../placementStore';

beforeEach(() => {
  resetPlacementForTests();
});

describe('#3243 ST-1 — placementStore (the placement lifecycle)', () => {
  describe('nothing is placed until something places it', () => {
    it('reads null before the first placement (never a synthetic identity)', () => {
      expect(readPlacement()).toBeNull();
    });

    it('is not persisted anywhere — the module exposes no storage/write path', () => {
      // A placement that survived a restart would resurrect a previous
      // conversation's identity, which is the defect AC-4 forbids. The guard is
      // a source read of the module itself (the pin sits beside the code it
      // constrains, so it cannot drift to another file).
      const source = readModuleSource();
      for (const forbidden of ['localStorage', 'sessionStorage', 'invoke(', 'adapterBridge']) {
        expect(source).not.toContain(forbidden);
      }
    });
  });

  describe('R-4a — every placement mints a NEW identity', () => {
    it('a second placeFredo mints a DISTINCT placementId and the store holds no reference to the first', () => {
      const first = placeFredo('wireframe', 'Wireframe');
      expect(first).not.toBeNull();
      const second = placeFredo('wireframe', 'Wireframe');
      expect(second).not.toBeNull();

      // The load-bearing assertion: the IDENTITIES differ. A store that reused
      // one id per app would satisfy "the store has one entry" and fail here.
      expect(first!.placementId).not.toBe(second!.placementId);
      expect(first!.startedAtSeq).toBeLessThan(second!.startedAtSeq);

      // The store holds the SECOND placement only — no first-identity reference.
      expect(readPlacement()).toBe(second);
      expect(readPlacement()!.placementId).not.toBe(first!.placementId);
    });

    it('two placements of DIFFERENT apps also mint distinct ids', () => {
      const wireframe = placeFredo('wireframe', 'Wireframe');
      const studio = placeFredo('db-client', 'SQL Studio');
      expect(wireframe!.placementId).not.toBe(studio!.placementId);
    });

    it('every id from a burst of placements is unique', () => {
      const ids = Array.from({ length: 25 }, () => placeFredo('wireframe', 'Wireframe')!.placementId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('FREEZES the placement, so a consumer cannot mutate the live identity', () => {
      const placement = placeFredo('wireframe', 'Wireframe')!;
      expect(Object.isFrozen(placement)).toBe(true);
      expect(() => {
        (placement as { appId: string }).appId = 'tampered';
      }).toThrow();
      expect(readPlacement()!.appId).toBe('wireframe');
    });

    it('falls back to the appId when the display name is blank (never an empty chip datum)', () => {
      const placement = placeFredo('wireframe', '   ')!;
      expect(placement.appName).toBe('wireframe');
    });
  });

  describe('the fail-closed edge — no resolved target is not a placement', () => {
    it('refuses a blank appId and mints nothing', () => {
      expect(placeFredo('', 'Nowhere')).toBeNull();
      expect(placeFredo('   ', 'Nowhere')).toBeNull();
      expect(readPlacement()).toBeNull();
    });

    it('refusing a blank id never disturbs an existing placement', () => {
      const placed = placeFredo('wireframe', 'Wireframe');
      expect(placeFredo('', 'Nowhere')).toBeNull();
      expect(readPlacement()).toBe(placed);
    });
  });

  describe('R-4b — leaving discards the placement', () => {
    it('clearPlacement empties the store AND bumps the subscription', () => {
      placeFredo('wireframe', 'Wireframe');
      const listener = vi.fn();
      const unsubscribe = subscribePlacement(listener);

      expect(readPlacement()).not.toBeNull();
      clearPlacement();

      expect(readPlacement()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('a later placement of the SAME app is FRESH — nothing of the first survives', () => {
      const first = placeFredo('wireframe', 'Wireframe')!;
      clearPlacement();
      const second = placeFredo('wireframe', 'Wireframe')!;

      expect(second.placementId).not.toBe(first.placementId);
      expect(second.startedAtSeq).toBeGreaterThan(first.startedAtSeq);
      expect(readPlacement()).toBe(second);
    });

    it('is idempotent — a duplicated leave notifies once, never flaps state', () => {
      placeFredo('wireframe', 'Wireframe');
      const listener = vi.fn();
      const unsubscribe = subscribePlacement(listener);

      clearPlacement();
      clearPlacement();
      clearPlacement();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(readPlacement()).toBeNull();
      unsubscribe();
    });
  });

  /**
   * ST-FP2 — the placement's SCOPE is separated from its IDENTITY.
   *
   * `placeFredo` sets `appId` AND rotates `placementId` in one operation, so a
   * resolved-target change could only be honoured by minting — which orphaned an
   * in-flight order's record (it is keyed on the id). `rescopePlacement` updates
   * the app IN PLACE and retains the identity.
   *
   * The defect world each pin rejects:
   *   - "re-scope rotates the id" ⇒ the in-flight flight becomes unreadable and
   *     the ticker disappears mid-order (AC-3's sharpest failure);
   *   - "re-scope mutates `startedAtSeq`" ⇒ the `companion.injection` receipt's
   *     identity stops being byte-stable, and re-scopes start counting as mints;
   *   - "re-scope replaces the record wholesale" ⇒ the identity is silently new
   *     and two placements can collide.
   */
  describe('ST-FP2 — a RE-SCOPE updates the app but RETAINS the identity', () => {
    it('retains placementId AND startedAtSeq while the app follows the move', () => {
      const first = placeFredo('wireframe', 'Wireframe')!;
      const rescoped = rescopePlacement('mission-monitor', 'Mission Monitor');

      expect(rescoped).not.toBeNull();
      // The SCOPE followed the move (R-3b / F-17 — the next order targets it).
      expect(rescoped!.appId).toBe('mission-monitor');
      expect(rescoped!.appName).toBe('Mission Monitor');
      // The IDENTITY did NOT rotate (AC-3 — a move does not end a placement).
      expect(rescoped!.placementId).toBe(first.placementId);
      expect(rescoped!.startedAtSeq).toBe(first.startedAtSeq);
      // …and the store holds the re-scoped value.
      expect(readPlacement()).toBe(rescoped);
      expect(readPlacement()!.placementId).toBe(first.placementId);
    });

    it('NOTIFIES on a real re-scope — a subscriber sees the app change', () => {
      placeFredo('wireframe', 'Wireframe');
      const listener = vi.fn();
      const unsubscribe = subscribePlacement(listener);

      rescopePlacement('mission-monitor', 'Mission Monitor');

      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('is a NO-OP for an already-live app (no notification, no new record)', () => {
      const placed = placeFredo('wireframe', 'Wireframe')!;
      const listener = vi.fn();
      const unsubscribe = subscribePlacement(listener);

      const again = rescopePlacement('wireframe', 'Wireframe');

      expect(again).toBe(placed);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('is a NO-OP when nothing is placed — a late first resolution must MINT, not re-scope', () => {
      const listener = vi.fn();
      const unsubscribe = subscribePlacement(listener);

      expect(rescopePlacement('wireframe', 'Wireframe')).toBeNull();

      expect(readPlacement()).toBeNull();
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('is a NO-OP for a blank app id — no resolved target is not a re-scope', () => {
      const placed = placeFredo('wireframe', 'Wireframe')!;
      expect(rescopePlacement('', 'Nowhere')).toBeNull();
      expect(rescopePlacement('   ', 'Nowhere')).toBeNull();
      expect(readPlacement()).toBe(placed);
      expect(readPlacement()!.appId).toBe('wireframe');
    });

    it('falls back to the app id when the re-scoped display name is blank', () => {
      placeFredo('wireframe', 'Wireframe');
      const rescoped = rescopePlacement('mission-monitor', '   ')!;
      expect(rescoped.appName).toBe('mission-monitor');
    });

    it('FREEZES the re-scoped placement, so a consumer cannot mutate the live scope', () => {
      placeFredo('wireframe', 'Wireframe');
      const rescoped = rescopePlacement('mission-monitor', 'Mission Monitor')!;
      expect(Object.isFrozen(rescoped)).toBe(true);
      expect(() => {
        (rescoped as { appId: string }).appId = 'tampered';
      }).toThrow();
      expect(readPlacement()!.appId).toBe('mission-monitor');
    });

    it('two PLACEMENTS still mint two distinct ids after a re-scope (F-18 stays green)', () => {
      // The green-green control: a re-scope is NOT a mint, so it must not perturb
      // the mint counter's meaning. A mint is what F-18 drives.
      const first = placeFredo('wireframe', 'Wireframe')!;
      rescopePlacement('mission-monitor', 'Mission Monitor');
      clearPlacement();
      const second = placeFredo('wireframe', 'Wireframe')!;

      expect(second.placementId).not.toBe(first.placementId);
      expect(second.startedAtSeq).toBeGreaterThan(first.startedAtSeq);
    });
  });

  describe('the subscription contract', () => {
    it('notifies on a mint, and not to an UNSUBSCRIBED listener', () => {
      const kept = vi.fn();
      const dropped = vi.fn();
      const unsubscribeKept = subscribePlacement(kept);
      const unsubscribeDropped = subscribePlacement(dropped);
      unsubscribeDropped();

      placeFredo('wireframe', 'Wireframe');

      expect(kept).toHaveBeenCalledTimes(1);
      expect(dropped).not.toHaveBeenCalled();
      unsubscribeKept();
    });

    it('a listener that unsubscribes during notification does not break the others', () => {
      const second = vi.fn();
      let unsubscribeFirst = () => {};
      const first = vi.fn(() => {
        unsubscribeFirst();
      });
      unsubscribeFirst = subscribePlacement(first);
      const unsubscribeSecond = subscribePlacement(second);

      placeFredo('wireframe', 'Wireframe');

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      unsubscribeSecond();
    });

    it('subscribe returns an idempotent unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = subscribePlacement(listener);
      unsubscribe();
      unsubscribe();
      placeFredo('wireframe', 'Wireframe');
      expect(listener).not.toHaveBeenCalled();
    });
  });
});

/** The module's own source, comments stripped (the doc prose legitimately NAMES
 *  the storage APIs it refuses). */
function readModuleSource(): string {
  const source = readFileSync(resolve(process.cwd(), 'src/shared/placement/placementStore.ts'), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
