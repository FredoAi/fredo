/**
 * #3010 ST-2 — the launcher-tile contract for the standalone Setup feature.
 *
 * Making Fredo Setup a user-chosen destination (AC2) is a single static flag
 * flip: `SetupFeature.showable` `false` → `true`, which the shipped
 * `Home.tsx` `SHOWABLE_FEATURES = ALL_FEATURES.filter((f) => f.showable)`
 * filter (`Home.tsx:35`) turns into a launcher tile
 * (`role="button"`, accessible name `Fredo Setup`, `LauncherAppGrid`).
 *
 * This suite freezes the four facts the tile route depends on:
 *   1. the stable feature id `setup` the window kernel + grid key on;
 *   2. the display / accessible name `Fredo Setup` (the tile's `aria-label`);
 *   3. `showable === true` (the sole gate on tile discoverability);
 *   4. the feature barrel registers `setup` EXACTLY ONCE — so the grid's
 *      `dedupeByApplicationId` can never need to drop a ghost tile and the
 *      binding hook `#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]`
 *      matches exactly one node.
 *
 * It asserts the frozen identity + registration contract only; the rendered
 * tile and its activation flow are owned by the seeded launcher/window-manager
 * suites (QA-executed, live policy).
 */

import { describe, it, expect, vi } from 'vitest';

// Stub the wizard so importing the feature barrel does not evaluate the heavy
// SetupWizard dependency graph (same idiom as SettingsFeature.contract.test.tsx).
vi.mock('../components/SetupWizard', () => ({ SetupWizard: () => null }));

// Wrap the REAL registry: `registerApplication` keeps its push semantics
// (called through), while `getApplications`/`dedupeByApplicationId` stay intact,
// so we can count the barrel's registration side-effect without a fake registry.
vi.mock('../../applicationRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../applicationRegistry')>();
  return {
    ...actual,
    registerApplication: vi.fn(actual.registerApplication),
  };
});

import { registerApplication, getApplications } from '../../applicationRegistry';
import { SetupFeature } from '../SetupFeature';
import { setupFeature } from '../index';

describe('#3010 ST-2 — SetupFeature launcher-tile contract', () => {
  it('exposes the stable id + name the launcher tile keys on', () => {
    expect(setupFeature.id).toBe('setup');
    expect(setupFeature.name).toBe('Fredo Setup');
  });

  it('is showable so the SHOWABLE_FEATURES filter includes setup in the tile grid', () => {
    expect(setupFeature.showable).toBe(true);
  });

  it('is the SetupFeature singleton instance', () => {
    expect(setupFeature).toBeInstanceOf(SetupFeature);
  });

  it('registers the setup feature exactly once (single registerApplication call)', () => {
    expect(registerApplication).toHaveBeenCalledTimes(1);
    expect(registerApplication).toHaveBeenCalledWith(setupFeature);
    // Exactly one registry entry for the id — the dedupe helper has nothing to
    // drop, so the launcher renders exactly one `Fredo Setup` tile.
    expect(getApplications().filter((f) => f.id === 'setup')).toHaveLength(1);
  });
});
