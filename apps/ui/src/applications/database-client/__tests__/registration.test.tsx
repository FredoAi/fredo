/**
 * database-client registration tests (Spec #2950, ST-7).
 *
 * Pins the auto-discovery contract: the feature's `index.ts` registers the
 * singleton (so the eager `import.meta.glob` in `allApplications.ts` finds it with
 * NO central-list edit), the singleton is a non-multi-window feature with a
 * settings panel, and the settings filter stays ADDITIVE (G-220) — an existing
 * `hasSettings` feature is not removed or masked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { FredoApplicationClass } from '@/shared/classes/FredoApplicationClass';
import { dedupeByApplicationId, getApplications, registerApplication } from '../../applicationRegistry';

afterEach(() => cleanup());

describe('database-client registration', () => {
  it('registers the singleton and keeps the settings section additive (G-220)', async () => {
    // Simulate an already-registered feature that owns a settings section.
    const existing = {
      id: 'existing-settings',
      name: 'Existing',
      hasSettings: true,
      renderSettings: () => null,
      showable: true,
    } as unknown as FredoApplicationClass;
    registerApplication(existing);

    const { databaseClientFeature } = await import('../index');

    expect(databaseClientFeature.id).toBe('database-client');
    expect(databaseClientFeature.name).toBe('PostgreSQL');
    expect(databaseClientFeature.hasSettings).toBe(true);
    expect(databaseClientFeature.isMultiWindow).toBe(false);
    expect(typeof databaseClientFeature.renderSettings).toBe('function');
    expect(typeof databaseClientFeature.render).toBe('function');

    const features = getApplications();
    expect(features.some((feature) => feature.id === 'database-client')).toBe(true);

    const settingsTabs = dedupeByApplicationId(features).filter(
      (feature) => feature.hasSettings && typeof feature.renderSettings === 'function',
    );
    expect(settingsTabs.map((feature) => feature.id)).toEqual(
      expect.arrayContaining(['existing-settings', 'database-client']),
    );
  });

  it('renderSettings returns the auto-discovered DatabaseClientSettings panel', async () => {
    const { databaseClientFeature } = await import('../index');
    renderWithChakra(<>{databaseClientFeature.renderSettings!()}</>);
    expect(await screen.findByTestId('dbclient-settings')).toBeInTheDocument();
  });
});
