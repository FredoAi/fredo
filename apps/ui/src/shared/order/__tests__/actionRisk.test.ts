/**
 * Spec #3243 ST-4 — the classification surface's pins (AC-6d's fail-closed arm).
 *
 * The G-520 rule binds every assertion here: a pin that passes on a broken
 * product is worse than none. So each case names the DEFECT WORLD it rejects —
 * principally a classifier that defaults to `read` (which would report
 * `granted` and execute a change nobody confirmed).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ORDER_RISK_CLASSES,
  OrderSurfaceRegistrationError,
  classifyOrder,
  classifyOrderAction,
  isOrderRiskClass,
  listOrderSurfaceAppIds,
  readOrderSurface,
  registerOrderSurface,
  resetOrderSurfacesForTests,
  unknownOrderClassification,
  type OrderRiskClass,
} from '../actionRisk';
import type { FredoOrderAction } from '../orderActions';

function action(overrides: Partial<FredoOrderAction> = {}): FredoOrderAction {
  return {
    id: 'demo.action',
    label: 'Do it',
    description: 'Does a thing.',
    risk: 'changing',
    undoable: true,
    args: [],
    ...overrides,
  };
}

afterEach(() => {
  resetOrderSurfacesForTests();
});

describe('actionRisk — the CLOSED risk vocabulary', () => {
  it('ORDER_RISK_CLASSES is EXACTLY the four classes, in order (not a toContain)', () => {
    // A fifth class added without a gate arm must redden THIS line: exact
    // equality, never a containment check.
    expect(ORDER_RISK_CLASSES).toEqual(['read', 'changing', 'destructive', 'unknown']);
    expect(ORDER_RISK_CLASSES).toHaveLength(4);
  });

  it('derives the union from the array (a value outside the array is not a class)', () => {
    const legal: readonly OrderRiskClass[] = [...ORDER_RISK_CLASSES];
    expect(legal).toHaveLength(4);
    expect(isOrderRiskClass('read')).toBe(true);
    expect(isOrderRiskClass('unknown')).toBe(true);
    // The defect world: a string that LOOKS like a class but is not one.
    expect(isOrderRiskClass('readonly')).toBe(false);
    expect(isOrderRiskClass('')).toBe(false);
    expect(isOrderRiskClass(undefined)).toBe(false);
    expect(isOrderRiskClass(3)).toBe(false);
  });
});

describe('actionRisk — fail CLOSED (the fail-open reading is the defect world)', () => {
  it('an UNREGISTERED app classifies unknown, never read', () => {
    const classification = classifyOrder('nobody-registered-this', 'any.action');
    expect(classification.risk).toBe('unknown');
    expect(classification.risk).not.toBe('read');
    expect(classification.undoable).toBe(false);
    expect(classification.consequence).toBeNull();
    expect(classification).toEqual(unknownOrderClassification());
  });

  it('an UNREGISTERED action id classifies unknown, never read', () => {
    registerOrderSurface('demo', { actions: [action()] });
    const classification = classifyOrder('demo', 'demo.no-such-action');
    expect(classification.risk).toBe('unknown');
    expect(classification.undoable).toBe(false);
    expect(classification.consequence).toBeNull();
  });

  it('a BLANK app id or action id classifies unknown (never a partial match)', () => {
    registerOrderSurface('demo', { actions: [action()] });
    expect(classifyOrder('', 'demo.action').risk).toBe('unknown');
    expect(classifyOrder('   ', 'demo.action').risk).toBe('unknown');
    expect(classifyOrder('demo', '').risk).toBe('unknown');
    expect(classifyOrder('demo', '  ').risk).toBe('unknown');
  });

  it('a declaration with a MISSING risk classifies unknown', () => {
    // A missing risk reaches the classifier only through a bypassed registration
    // (registration refuses it) — the classifier must still fail closed.
    const broken = { ...action(), risk: undefined } as unknown as FredoOrderAction;
    expect(classifyOrderAction(broken).risk).toBe('unknown');
  });

  it('a declaration with an UNKNOWN risk string classifies unknown', () => {
    const broken = { ...action(), risk: 'kinda-dangerous' } as unknown as FredoOrderAction;
    expect(classifyOrderAction(broken).risk).toBe('unknown');
  });
});

describe('actionRisk — the read invariant', () => {
  it('a read is never undoable and never carries a consequence', () => {
    const classification = classifyOrderAction(
      action({ risk: 'read', undoable: false, consequence: undefined }),
    );
    expect(classification).toEqual({ risk: 'read', undoable: false, consequence: null });
  });

  it('a read declaring undoable:true is REFUSED at registration', () => {
    expect(() =>
      registerOrderSurface('demo', {
        actions: [action({ risk: 'read', undoable: true })],
      }),
    ).toThrow(OrderSurfaceRegistrationError);
  });

  it('a read declaring a consequence is REFUSED at registration (a vacuous warning is a lie)', () => {
    expect(() =>
      registerOrderSurface('demo', {
        actions: [action({ risk: 'read', undoable: false, consequence: 'nothing happens' })],
      }),
    ).toThrow(/cannot declare a consequence/);
  });
});

describe('actionRisk — the irreversible declaration is warnable or refused', () => {
  it('an undoable action classifies undoable with a null consequence', () => {
    const classification = classifyOrderAction(action({ risk: 'destructive', undoable: true }));
    expect(classification).toEqual({ risk: 'destructive', undoable: true, consequence: null });
  });

  it('an irreversible action WITH a consequence classifies undoable:false + the sentence', () => {
    const classification = classifyOrderAction(
      action({ risk: 'destructive', undoable: false, consequence: 'This wipes the document.' }),
    );
    expect(classification).toEqual({
      risk: 'destructive',
      undoable: false,
      consequence: 'This wipes the document.',
    });
  });

  it('an action with undoable:false and NO consequence is REFUSED at registration', () => {
    // The AC-8 guard: an un-warnable irreversible action cannot ship. Without
    // this refusal the confirmation would have nothing to render pre-run.
    expect(() =>
      registerOrderSurface('demo', {
        actions: [action({ risk: 'destructive', undoable: false })],
      }),
    ).toThrow(/MUST declare a consequence/);
  });

  it('an action with undoable:false and a BLANK consequence is REFUSED at registration', () => {
    expect(() =>
      registerOrderSurface('demo', {
        actions: [action({ risk: 'destructive', undoable: false, consequence: '   ' })],
      }),
    ).toThrow(/MUST declare a consequence/);
  });

  it('an irreversible declaration that bypassed registration classifies UNKNOWN (not runnable)', () => {
    // The defence in depth: even if a declaration reaches the classifier without
    // a consequence, the gate must refuse rather than run it un-warned.
    const bypassed = action({ risk: 'destructive', undoable: false, consequence: '' });
    expect(classifyOrderAction(bypassed).risk).toBe('unknown');
    expect(classifyOrderAction(bypassed).undoable).toBe(false);
  });
});

describe('actionRisk — the registration contract', () => {
  it('the LAST registration for an app wins', () => {
    registerOrderSurface('demo', { actions: [action({ id: 'first' })] });
    registerOrderSurface('demo', { actions: [action({ id: 'second' })] });
    expect(readOrderSurface('demo')?.actions.map((entry) => entry.id)).toEqual(['second']);
    expect(classifyOrder('demo', 'first').risk).toBe('unknown');
    expect(classifyOrder('demo', 'second').risk).toBe('changing');
  });

  it('the disposer is IDEMPOTENT and never removes a newer registration', () => {
    const disposeFirst = registerOrderSurface('demo', { actions: [action({ id: 'first' })] });
    registerOrderSurface('demo', { actions: [action({ id: 'second' })] });
    disposeFirst();
    expect(readOrderSurface('demo')?.actions.map((entry) => entry.id)).toEqual(['second']);
    disposeFirst();
    expect(listOrderSurfaceAppIds()).toEqual(['demo']);
    resetOrderSurfacesForTests();
    expect(listOrderSurfaceAppIds()).toEqual([]);
  });

  it('a duplicate action id inside one surface is REFUSED', () => {
    expect(() =>
      registerOrderSurface('demo', { actions: [action({ id: 'same' }), action({ id: 'same' })] }),
    ).toThrow(/declared twice/);
  });

  it('a blank app id, id, label, description or argument name is REFUSED', () => {
    expect(() => registerOrderSurface('  ', { actions: [] })).toThrow(/non-empty app id/);
    expect(() => registerOrderSurface('demo', { actions: [action({ id: ' ' })] })).toThrow(
      /non-empty id/,
    );
    expect(() => registerOrderSurface('demo', { actions: [action({ label: '' })] })).toThrow(
      /label is required/,
    );
    expect(() =>
      registerOrderSurface('demo', { actions: [action({ description: ' ' })] }),
    ).toThrow(/description is required/);
    expect(() =>
      registerOrderSurface('demo', {
        actions: [
          action({ args: [{ name: ' ', type: 'string', required: true }] }),
        ],
      }),
    ).toThrow(/argument needs a name/);
  });

  it('an app that registers NOTHING has no surface and refuses every order', () => {
    // The honest default for the shipped apps that declare no order surface:
    // they can be placed, but nothing in them is addressable.
    expect(readOrderSurface('an-app-with-no-surface')).toBeNull();
    expect(classifyOrder('an-app-with-no-surface', 'wireframe.element.fill').risk).toBe('unknown');
  });
});
