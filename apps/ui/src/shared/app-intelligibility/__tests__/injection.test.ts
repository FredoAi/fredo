/**
 * Spec #3243 ST-3 — the extended per-turn receipt (R-1a / R-3c / R-4a).
 *
 * The three new fields are REQUIRED on the wire, and the test that matters is
 * the BOUNDARY one (G-413): assert the SERIALIZED payload carries all three keys
 * in BOTH polarities (a placed turn and an unplaced turn), and assert that the
 * three facts DERIVE from the run — the placement store's live identity and the
 * app's declared action table — never from a constant.
 *
 * The consuming side of the boundary lives in the Rust module's own tests
 * (`applications/llm_server/injection.rs`): the real wire shape is fed to the
 * deserializer and a payload missing any of the three is REFUSED. A test built
 * from the authoring type alone would prove only that the authoring type is
 * happy.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_ORDER_SURFACE_DIGEST,
  buildCompanionInjectionFacts,
  type CompanionInjectionFacts,
  type OrderSurfaceFactSource,
} from '../injection';
import { contentDigest, serializeOutline } from '../screenOutline';
import type { ScreenOutline } from '../screenOutline';
import { clearPlacement, placeFredo, resetPlacementForTests } from '../../placement/placementStore';

const OUTLINE: ScreenOutline = {
  nodes: [{ role: 'button', name: 'Save', tag: 'button', bbox: [1, 2, 3, 4] }],
  truncated: false,
};

/** The four-action surface this slice's Wireframe instance declares. */
const DECLARED_SURFACE: OrderSurfaceFactSource = {
  actions: [
    { id: 'wireframe.selection.describe', risk: 'read', undoable: false },
    { id: 'wireframe.element.fill', risk: 'changing', undoable: true },
    { id: 'wireframe.element.delete', risk: 'destructive', undoable: true },
    { id: 'wireframe.document.new', risk: 'destructive', undoable: false },
  ],
};

/** What actually crosses the IPC boundary: the facts as JSON. */
function serialize(facts: CompanionInjectionFacts): Record<string, unknown> {
  return JSON.parse(JSON.stringify(facts)) as Record<string, unknown>;
}

function factsFor(over: Partial<Parameters<typeof buildCompanionInjectionFacts>[0]> = {}) {
  return buildCompanionInjectionFacts({
    appId: 'wireframe',
    outline: OUTLINE,
    screenshotPngBase64: 'iVBORw0KGgo=',
    ...over,
  });
}

beforeEach(() => {
  resetPlacementForTests();
});

describe('#3243 ST-3 — the extended per-turn receipt', () => {
  describe('placementId (R-4a)', () => {
    it('is the EMPTY string when Fredo is not placed — a real value, never an absent key', () => {
      const facts = factsFor();
      expect(facts.placementId).toBe('');

      const wire = serialize(facts);
      expect(Object.prototype.hasOwnProperty.call(wire, 'placementId')).toBe(true);
      expect(wire.placementId).toBe('');
      expect(wire.placementId).not.toBeNull();
    });

    it('carries the LIVE placement identity when Fredo is placed', () => {
      const placement = placeFredo('wireframe', 'Wireframe')!;
      const facts = factsFor();
      expect(facts.placementId).toBe(placement.placementId);
      expect(facts.placementId).not.toBe('');

      const wire = serialize(facts);
      expect(wire.placementId).toBe(placement.placementId);
    });

    it('two placements of the SAME app produce two DISTINCT receipt values', () => {
      // The AC-4 receipt: two placements must never share an identity.
      const first = placeFredo('wireframe', 'Wireframe')!;
      const firstFacts = factsFor();
      clearPlacement();
      const second = placeFredo('wireframe', 'Wireframe')!;
      const secondFacts = factsFor();

      expect(first.placementId).not.toBe(second.placementId);
      expect(firstFacts.placementId).not.toBe(secondFacts.placementId);
      expect(firstFacts.placementId).toBe(first.placementId);
      expect(secondFacts.placementId).toBe(second.placementId);
    });

    it('after leaving, the receipt is empty again (nothing is recalled across placements)', () => {
      placeFredo('wireframe', 'Wireframe');
      expect(factsFor().placementId).not.toBe('');
      clearPlacement();
      expect(factsFor().placementId).toBe('');
    });
  });

  describe('orderActionCount / orderSurfaceDigest (R-1a)', () => {
    it('reports 0 actions and the EMPTY-table digest when the app declares none', () => {
      const facts = factsFor();
      expect(facts.orderActionCount).toBe(0);
      expect(facts.orderSurfaceDigest).toBe(EMPTY_ORDER_SURFACE_DIGEST);

      const wire = serialize(facts);
      expect(wire.orderActionCount).toBe(0);
      expect(wire.orderSurfaceDigest).toBe(EMPTY_ORDER_SURFACE_DIGEST);
      // Present, never absent and never null (the required-field contract).
      for (const key of ['orderActionCount', 'orderSurfaceDigest']) {
        expect(Object.prototype.hasOwnProperty.call(wire, key)).toBe(true);
        expect(wire[key]).not.toBeNull();
      }
    });

    it('reports the DECLARED count and a digest of the declared table', () => {
      const facts = factsFor({ orderSurface: DECLARED_SURFACE });
      expect(facts.orderActionCount).toBe(4);

      // The digest is of the canonical table (id, risk, undoable per action, in
      // declaration order) — recomputable from this test, not a magic literal.
      const canonical = JSON.stringify(
        DECLARED_SURFACE.actions.map((action) => [action.id, action.risk, action.undoable]),
      );
      expect(facts.orderSurfaceDigest).toBe(contentDigest(canonical));
      expect(facts.orderSurfaceDigest).not.toBe(EMPTY_ORDER_SURFACE_DIGEST);
    });

    it('the empty digest is DERIVED from the canonical empty table (recomputable)', () => {
      expect(EMPTY_ORDER_SURFACE_DIGEST).toBe(contentDigest(JSON.stringify([])));
      expect(EMPTY_ORDER_SURFACE_DIGEST).toMatch(/^[0-9a-f]+$/);
    });

    it('a DIFFERENT declared table yields a DIFFERENT digest (the field is content-derived)', () => {
      const fewer = factsFor({
        orderSurface: { actions: DECLARED_SURFACE.actions.slice(0, 2) },
      });
      const full = factsFor({ orderSurface: DECLARED_SURFACE });
      expect(fewer.orderActionCount).toBe(2);
      expect(fewer.orderSurfaceDigest).not.toBe(full.orderSurfaceDigest);
    });

    it('a changed RISK changes the digest even at the same action count', () => {
      // The digest covers the classification, not just the ids: an app that
      // reclassifies an action has a different surface.
      const reclassified = factsFor({
        orderSurface: {
          actions: DECLARED_SURFACE.actions.map((action, index) =>
            index === 1 ? { ...action, risk: 'destructive' } : action,
          ),
        },
      });
      const original = factsFor({ orderSurface: DECLARED_SURFACE });
      expect(reclassified.orderActionCount).toBe(original.orderActionCount);
      expect(reclassified.orderSurfaceDigest).not.toBe(original.orderSurfaceDigest);
    });

    it('declaration ORDER is part of the digest (the offer order the model sees)', () => {
      const reordered = factsFor({
        orderSurface: { actions: [...DECLARED_SURFACE.actions].reverse() },
      });
      const original = factsFor({ orderSurface: DECLARED_SURFACE });
      expect(reordered.orderActionCount).toBe(original.orderActionCount);
      expect(reordered.orderSurfaceDigest).not.toBe(original.orderSurfaceDigest);
    });
  });

  describe('the three fields are on EVERY receipt, in both polarities', () => {
    it('a placed, action-declaring turn carries all three non-default values', () => {
      placeFredo('wireframe', 'Wireframe');
      const wire = serialize(factsFor({ orderSurface: DECLARED_SURFACE }));
      expect(wire.placementId).not.toBe('');
      expect(wire.orderActionCount).toBe(4);
      expect(wire.orderSurfaceDigest).not.toBe(EMPTY_ORDER_SURFACE_DIGEST);
    });

    it('an unplaced, action-free turn carries all three as present real values', () => {
      const wire = serialize(factsFor());
      expect(wire.placementId).toBe('');
      expect(wire.orderActionCount).toBe(0);
      expect(wire.orderSurfaceDigest).toBe(EMPTY_ORDER_SURFACE_DIGEST);
    });

    it('the shipped #3244 facts are unchanged by the extension', () => {
      // G-522: the widening must not disturb what the receipt already carried.
      const facts = factsFor({ description: 'A sample app.' });
      expect(facts.appId).toBe('wireframe');
      expect(facts.taught).toBe(false);
      expect(facts.perAppEntries).toBe(0);
      expect(facts.simplifiedHtmlNodes).toBe(1);
      expect(facts.simplifiedHtmlTruncated).toBe(false);
      expect(facts.simplifiedHtmlDigest).toBe(contentDigest(serializeOutline(OUTLINE)));
    });
  });
});
