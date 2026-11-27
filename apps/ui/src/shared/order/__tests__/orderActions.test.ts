/**
 * Spec #3243 ST-4 — the dispatch datum and the fingerprint's pins.
 *
 * The fingerprint is the grant's scope (AC-7): a grant minted for one invocation
 * must never authorise a different one. So the digest's pin is not "it is a
 * string" — it is that a DIFFERENT arg VALUE, a different arg NAME, and a
 * different action id all produce a different fingerprint, while the same
 * invocation is byte-stable across runs (and across key insertion order).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerOrderSurface, resetOrderSurfacesForTests } from '../actionRisk';
import {
  buildOrderInvocation,
  canonicalOrderArgs,
  fingerprintOrder,
  type FredoOrderSurface,
} from '../orderActions';

const SURFACE: FredoOrderSurface = {
  actions: [
    {
      id: 'demo.fill',
      label: 'Fill element',
      description: 'Set one fill.',
      risk: 'changing',
      undoable: true,
      args: [
        { name: 'elementId', type: 'string', required: true },
        { name: 'fill', type: 'string', required: true },
      ],
    },
    {
      id: 'demo.new',
      label: 'Create a new document',
      description: 'Replace everything.',
      risk: 'destructive',
      undoable: false,
      consequence: 'The current document is discarded.',
      args: [],
    },
  ],
};

afterEach(() => {
  resetOrderSurfacesForTests();
});

describe('canonicalOrderArgs — order-independent canonical text', () => {
  it('sorts keys, so insertion order cannot change the digest', () => {
    expect(canonicalOrderArgs({ b: '2', a: '1' })).toBe(canonicalOrderArgs({ a: '1', b: '2' }));
  });

  it('is injective for a changed VALUE', () => {
    expect(canonicalOrderArgs({ a: '1' })).not.toBe(canonicalOrderArgs({ a: '2' }));
  });

  it('is injective for a changed KEY NAME (no key/value collision)', () => {
    expect(canonicalOrderArgs({ a: 'b' })).not.toBe(canonicalOrderArgs({ b: 'a' }));
  });

  it('renders the empty argument set deterministically', () => {
    expect(canonicalOrderArgs({})).toBe(canonicalOrderArgs({}));
    expect(canonicalOrderArgs({})).toBe('[]');
  });
});

describe('fingerprintOrder — the grant scope', () => {
  it('same app + action + args ⇒ the same fingerprint', () => {
    const left = fingerprintOrder('wireframe', 'demo.fill', { elementId: 'e1', fill: 'accent' });
    const right = fingerprintOrder('wireframe', 'demo.fill', { fill: 'accent', elementId: 'e1' });
    expect(left).toBe(right);
  });

  it('a DIFFERENT arg value ⇒ a different fingerprint', () => {
    const accent = fingerprintOrder('wireframe', 'demo.fill', { elementId: 'e1', fill: 'accent' });
    const error = fingerprintOrder('wireframe', 'demo.fill', { elementId: 'e1', fill: 'error' });
    expect(accent).not.toBe(error);
  });

  it('a DIFFERENT action id or app id ⇒ a different fingerprint', () => {
    const base = fingerprintOrder('wireframe', 'demo.fill', { elementId: 'e1' });
    expect(fingerprintOrder('wireframe', 'demo.delete', { elementId: 'e1' })).not.toBe(base);
    expect(fingerprintOrder('other-app', 'demo.fill', { elementId: 'e1' })).not.toBe(base);
  });

  it('is a 16-hex-character token (stable shape, no whitespace)', () => {
    const fingerprint = fingerprintOrder('wireframe', 'demo.fill', { elementId: 'e1' });
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('an INJECTED confirmation-shaped argument changes the fingerprint (never rides a clean grant)', () => {
    // R-7c: `{ confirmed: true }` is model data in `args`. Keeping it in the
    // digest is the SAFER direction — the tampered invocation cannot present the
    // clean invocation's grant.
    const clean = fingerprintOrder('wireframe', 'demo.fill', { elementId: 'e1' });
    const tampered = fingerprintOrder('wireframe', 'demo.fill', {
      elementId: 'e1',
      confirmed: 'true',
    });
    expect(tampered).not.toBe(clean);
  });
});

describe('buildOrderInvocation — the dispatch datum takes its risk from the REGISTRY', () => {
  it('carries the registry risk/undoable/consequence, not anything supplied by a caller', () => {
    registerOrderSurface('demo', SURFACE);
    const invocation = buildOrderInvocation('demo', 'demo.fill', { elementId: 'e1', fill: 'accent' });
    expect(invocation).not.toBeNull();
    expect(invocation?.risk).toBe('changing');
    expect(invocation?.undoable).toBe(true);
    expect(invocation?.consequence).toBeNull();
  });

  it('carries the declared consequence for an irreversible action', () => {
    registerOrderSurface('demo', SURFACE);
    const invocation = buildOrderInvocation('demo', 'demo.new');
    expect(invocation?.risk).toBe('destructive');
    expect(invocation?.undoable).toBe(false);
    expect(invocation?.consequence).toBe('The current document is discarded.');
  });

  it('an UNRESOLVED action still yields an invocation, classifying UNKNOWN (fail closed)', () => {
    registerOrderSurface('demo', SURFACE);
    const invocation = buildOrderInvocation('demo', 'demo.no-such-action', {});
    expect(invocation).not.toBeNull();
    expect(invocation?.risk).toBe('unknown');
    expect(invocation?.undoable).toBe(false);
    expect(invocation?.consequence).toBeNull();
  });

  it('returns NULL only for a structurally absent order (blank app or blank action)', () => {
    registerOrderSurface('demo', SURFACE);
    expect(buildOrderInvocation('', 'demo.fill', {})).toBeNull();
    expect(buildOrderInvocation('   ', 'demo.fill', {})).toBeNull();
    expect(buildOrderInvocation('demo', '', {})).toBeNull();
    expect(buildOrderInvocation('demo', '  ', {})).toBeNull();
  });

  it('trims the app and action ids but keeps the args verbatim', () => {
    registerOrderSurface('demo', SURFACE);
    const invocation = buildOrderInvocation('  demo  ', '  demo.fill  ', {
      elementId: '  e1  ',
      fill: 'accent',
    });
    expect(invocation?.appId).toBe('demo');
    expect(invocation?.actionId).toBe('demo.fill');
    // Arguments are the MODEL's; the dispatcher/executor decides what they mean.
    expect(invocation?.args.elementId).toBe('  e1  ');
  });

  it("the invocation's fingerprint equals fingerprintOrder over the same parts", () => {
    registerOrderSurface('demo', SURFACE);
    const invocation = buildOrderInvocation('demo', 'demo.fill', { elementId: 'e1' });
    expect(invocation?.fingerprint).toBe(fingerprintOrder('demo', 'demo.fill', { elementId: 'e1' }));
  });
});
