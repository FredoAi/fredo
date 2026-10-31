/**
 * Spec #3122 ST-4 — the boot registration set is exactly the retained eight.
 *
 * The `allApplications` barrel eagerly imports every `applications/<id>/index.ts`
 * side effect (there are no manual entries to delete), so deleting the eight
 * deprecated trees IS the de-registration. This test pins that documented set
 * plus each retained application's `showable` flag, so a deleted app can never
 * silently return and a retained app's launcher visibility can never drift.
 *
 * `home` and `doom` are intentionally absent: neither calls `registerApplication`
 * (they are route roots, not registry features).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { getApplications, resetApplicationRegistryForTests } from '../applicationRegistry';

/**
 * The retained registry features and their current `showable` flags. Dev Mode
 * (and the settings-only Theming app) are hidden from the launcher but retained.
 */
const RETAINED_SHOWABLE: Readonly<Record<string, boolean>> = {
  wireframe: true,
  terminal: true,
  'mission-monitor': true,
  'database-client': true,
  theming: false,
  setup: true,
  settings: true,
  'dev-mode': false,
};

beforeAll(async () => {
  // Deterministic: start empty, then load the real module graph once.
  resetApplicationRegistryForTests();
  await import('../allApplications');
});

describe('#3122 ST-4 — the retained application set', () => {
  it('registers exactly the eight retained features (no more, no fewer)', () => {
    const ids = getApplications().map((feature) => feature.id);

    // Set equality (registration order independent) and no duplicate registration.
    expect([...ids].sort()).toEqual(Object.keys(RETAINED_SHOWABLE).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every retained application\u2019s showable flag unchanged', () => {
    for (const feature of getApplications()) {
      expect(feature.showable, feature.id).toBe(RETAINED_SHOWABLE[feature.id]);
    }
  });

  it('never registers a deleted application', () => {
    const ids = new Set(getApplications().map((feature) => feature.id));
    // Every registered id is in the retained map — no deleted id can be a member.
    for (const id of ids) expect(RETAINED_SHOWABLE[id], id).toBeDefined();
  });
});
