/**
 * Spec #3117 (P3) — ST-4 root-export proof (supports AC1 / REQ-01.1).
 *
 * The NavigationEngine is reachable through the ONE additive line in
 * `apps/ui/src/index.ts` (`export * from './shared/navigation';`). This suite imports the
 * six key entry points through `@/index` — not through the module barrel — so the additive
 * root export is proven end-to-end and no name is silently dropped or made ambiguous by
 * `export *`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCompanionManifest,
  buildContextEnvelope,
  createRegistry,
  dispatch,
  resolveStroke,
  validateSurface,
} from '@/index';
import { makeSnapshot, validWireframeSurface } from './fixtures';

describe('root export', () => {
  it('root export exposes the six navigation entry points', () => {
    for (const entryPoint of [
      buildCompanionManifest,
      buildContextEnvelope,
      createRegistry,
      dispatch,
      resolveStroke,
      validateSurface,
    ]) {
      expect(typeof entryPoint).toBe('function');
    }
  });

  it('root-exported entry points are the live implementations', () => {
    const surface = validWireframeSurface();

    expect(createRegistry(surface).rootId).toBe('wireframe.canvas');
    expect(validateSurface(surface).valid).toBe(true);
    expect(buildCompanionManifest(surface).appId).toBe('wireframe');
    expect(buildContextEnvelope(surface, makeSnapshot(), []).version).toBe(1);

    const resolution = resolveStroke({
      surface,
      placePath: ['wireframe.canvas'],
      pending: null,
      stroke: 'c',
      nowMs: 0,
      keyboardOwner: 'engine',
    });
    expect(resolution.status).toBe('dispatch');
    if (resolution.status === 'dispatch') {
      expect(resolution.intent.verbId).toBe('place.create');
    }
  });
});
