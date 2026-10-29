/**
 * Application registry subscription (Spec #3099, ST-2).
 *
 * Pins:
 *   - registration stays a plain push and the listener fires AFTER the push;
 *   - unsubscribe stops notifications;
 *   - the test reset empties both the registry and the subscription set.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FredoApplicationClass } from '@/shared/classes';
import {
  getApplications,
  registerApplication,
  resetApplicationRegistryForTests,
  subscribeApplications,
} from '../applicationRegistry';

function feature(id: string): FredoApplicationClass {
  return { id, name: id } as unknown as FredoApplicationClass;
}

beforeEach(() => {
  resetApplicationRegistryForTests();
});

describe('subscribeApplications', () => {
  it('notifies AFTER the feature is pushed', () => {
    let observed: string[] = [];
    const listener = vi.fn(() => {
      observed = getApplications().map((entry) => entry.id);
    });

    subscribeApplications(listener);
    registerApplication(feature('alpha'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(['alpha']);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeApplications(listener);

    registerApplication(feature('alpha'));
    unsubscribe();
    registerApplication(feature('beta'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getApplications().map((entry) => entry.id)).toEqual(['alpha', 'beta']);
  });

  it('supports multiple independent subscribers', () => {
    const first = vi.fn();
    const second = vi.fn();

    subscribeApplications(first);
    subscribeApplications(second);
    registerApplication(feature('alpha'));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('resetApplicationRegistryForTests', () => {
  it('empties the registry in place and clears subscribers', () => {
    const listener = vi.fn();
    subscribeApplications(listener);
    registerApplication(feature('alpha'));

    // The live reference handed out by getApplications() is mutated in place.
    const live = getApplications();
    resetApplicationRegistryForTests();

    expect(live).toHaveLength(0);
    expect(getApplications()).toHaveLength(0);

    // Listeners were cleared, so a later registration does not notify the
    // pre-reset subscriber.
    registerApplication(feature('beta'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getApplications().map((entry) => entry.id)).toEqual(['beta']);
  });
});
