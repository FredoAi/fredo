/**
 * Spec #3151 (ST-2) — product-unit pins for the application-level companion
 * grounding source (`shared/companion/grounding.ts`), the engine-free replacement
 * for the retired `NavigationHost.describeContext()` / `ContextEnvelope` path.
 *
 * Deterministic, no React harness: the module is a pure module-scoped
 * `Map<appId, provider>` read synchronously at turn time, so every guarantee AC5
 * relies on is asserted directly:
 *
 *   - FRESH read: a provider is invoked on EVERY read (never a cached payload);
 *   - unknown app → `null` (R-5.3's ungrounded-turn fallback);
 *   - the disposer is idempotent (double-call, and a stale disposer after a newer
 *     registration, never removes the newer provider);
 *   - per-app isolation (one app's registration/disposal never touches another's);
 *   - field-by-field shape of the projection (version/appId/appName/selection/dirty).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPANION_CAPABILITY_LIMITS,
  COMPANION_GROUNDING_VERSION,
  listCompanionGroundingAppIds,
  readCompanionGrounding,
  registerCompanionGrounding,
  resetCompanionGroundingForTests,
} from '../grounding';
import type { CompanionGrounding } from '../grounding';

function payload(appId: string, overrides: Partial<CompanionGrounding> = {}): CompanionGrounding {
  return {
    version: COMPANION_GROUNDING_VERSION,
    appId,
    appName: appId === 'wireframe' ? 'Wireframe' : 'SQL Studio',
    selection: { count: 1, kinds: ['element'], label: 'Rectangle', ids: ['el-1'] },
    dirty: false,
    ...overrides,
  };
}

afterEach(() => {
  resetCompanionGroundingForTests();
  vi.restoreAllMocks();
});

describe('#3151 ST-2 — the grounding constants', () => {
  it('exposes version 1 and the unchanged 16384-byte cap', () => {
    expect(COMPANION_GROUNDING_VERSION).toBe(1);
    expect(COMPANION_CAPABILITY_LIMITS.maxContextBytes).toBe(16384);
    // A frozen value — a caller can never widen the cap.
    expect(Object.isFrozen(COMPANION_CAPABILITY_LIMITS)).toBe(true);
  });
});

describe('#3151 ST-2 — readCompanionGrounding', () => {
  it('returns null for an app that registered no source (R-5.3)', () => {
    expect(readCompanionGrounding('wireframe')).toBeNull();
    expect(readCompanionGrounding('never-registered')).toBeNull();
  });

  it('reads a FRESH payload on every call — never a cached snapshot', () => {
    let count = 0;
    registerCompanionGrounding('wireframe', () =>
      payload('wireframe', { selection: { count: ++count, kinds: ['text'], label: 'Text', ids: [`el-${count}`] } }),
    );

    const first = readCompanionGrounding('wireframe');
    const second = readCompanionGrounding('wireframe');

    expect(first?.selection.count).toBe(1);
    expect(second?.selection.count).toBe(2);
    // Distinct objects — the module never memoizes the payload.
    expect(first).not.toBe(second);
  });

  it('projects the exact field-by-field grounding shape', () => {
    const source = payload('wireframe', {
      selection: { count: 2, kinds: ['text', 'shape'], label: 'Text', ids: ['a', 'b'] },
      dirty: true,
    });
    registerCompanionGrounding('wireframe', () => source);

    const read = readCompanionGrounding('wireframe');

    expect(read).toStrictEqual({
      version: 1,
      appId: 'wireframe',
      appName: 'Wireframe',
      selection: { count: 2, kinds: ['text', 'shape'], label: 'Text', ids: ['a', 'b'] },
      dirty: true,
    });
    // No envelope residue: no place path, no verbs, no journal, no limits map.
    expect(read).not.toHaveProperty('placePath');
    expect(read).not.toHaveProperty('verbs');
    expect(read).not.toHaveProperty('journal');
    expect(read).not.toHaveProperty('limits');
  });

  it('passes a provider-level null straight through (an app may report "no grounding")', () => {
    registerCompanionGrounding('wireframe', () => null);
    expect(readCompanionGrounding('wireframe')).toBeNull();
  });
});

describe('#3151 ST-2 — registerCompanionGrounding', () => {
  it('lets the LAST registration for an appId win', () => {
    registerCompanionGrounding('wireframe', () => payload('wireframe', { appName: 'First' }));
    registerCompanionGrounding('wireframe', () => payload('wireframe', { appName: 'Second' }));

    expect(readCompanionGrounding('wireframe')?.appName).toBe('Second');
    expect(listCompanionGroundingAppIds()).toEqual(['wireframe']);
  });

  it('is idempotent: calling the disposer twice is a no-op', () => {
    const dispose = registerCompanionGrounding('wireframe', () => payload('wireframe'));
    dispose();
    dispose();

    expect(readCompanionGrounding('wireframe')).toBeNull();
    expect(listCompanionGroundingAppIds()).toEqual([]);
  });

  it('never removes a NEWER registration (a stale disposer is inert)', () => {
    const disposeStale = registerCompanionGrounding('wireframe', () => payload('wireframe', { appName: 'Old' }));
    registerCompanionGrounding('wireframe', () => payload('wireframe', { appName: 'New' }));

    // The StrictMode-remount shape: the departing registration's cleanup runs AFTER
    // the replacement landed. It must not delete the live newer entry.
    disposeStale();

    expect(readCompanionGrounding('wireframe')?.appName).toBe('New');
    expect(listCompanionGroundingAppIds()).toEqual(['wireframe']);
  });

  it('isolates apps: one app registration/disposal never touches another', () => {
    const disposeWireframe = registerCompanionGrounding('wireframe', () => payload('wireframe'));
    registerCompanionGrounding('terminal', () => payload('terminal', { appName: 'Terminal' }));

    expect(listCompanionGroundingAppIds().sort()).toEqual(['terminal', 'wireframe']);

    disposeWireframe();

    expect(readCompanionGrounding('wireframe')).toBeNull();
    expect(readCompanionGrounding('terminal')?.appName).toBe('Terminal');
    expect(listCompanionGroundingAppIds()).toEqual(['terminal']);
  });

  it('ignores a blank appId (defensive: never registers an unreachable entry)', () => {
    const dispose = registerCompanionGrounding('   ', () => payload('blank'));
    expect(dispose).toBeTypeOf('function');
    expect(() => dispose()).not.toThrow();
    expect(listCompanionGroundingAppIds()).toEqual([]);
  });

  it('resetCompanionGroundingForTests drops every registration', () => {
    registerCompanionGrounding('wireframe', () => payload('wireframe'));
    registerCompanionGrounding('terminal', () => payload('terminal'));

    resetCompanionGroundingForTests();

    expect(listCompanionGroundingAppIds()).toEqual([]);
    expect(readCompanionGrounding('wireframe')).toBeNull();
    expect(readCompanionGrounding('terminal')).toBeNull();
  });
});
