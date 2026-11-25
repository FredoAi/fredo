/**
 * postgresConfigStore — the `pg_supervisor_status` consumer boundary (#3188 ST-3;
 * #3194 ST-3 removes the retired attach state from the closed state guard).
 *
 * `getPgSupervisorStatus` runs the raw IPC payload through a CLOSED
 * `isFailureKind` validator. That validator is NOT exhaustiveness-checked, so an
 * omission fails SILENTLY: the typed cause is dropped to `null` at the store
 * boundary. These pins guard both directions — the new `dataDirPermissionDenied`
 * member survives, and an unknown value (`somethingElse`) is still dropped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { adapterBridge } from '@/shared/utils/adapterBridge';

import { getPgSupervisorStatus } from '../postgresConfigStore';

function setInvoke(fn: () => Promise<unknown>) {
  adapterBridge.setInvoke(fn as never);
}

afterEach(() => {
  adapterBridge.setInvoke(undefined as never);
  vi.restoreAllMocks();
});

describe('getPgSupervisorStatus — closed failureKind validator (#3188 ST-3)', () => {
  it('preserves dataDirPermissionDenied through the closed validator', async () => {
    setInvoke(async () => ({
      state: 'failed',
      failureKind: 'dataDirPermissionDenied',
      error: 'permission refused',
    }));

    const status = await getPgSupervisorStatus();
    expect(status.state).toBe('failed');
    expect(status.failureKind).toBe('dataDirPermissionDenied');
  });

  it("drops an unknown failureKind ('somethingElse') to null", async () => {
    setInvoke(async () => ({ state: 'failed', failureKind: 'somethingElse', error: 'raw' }));

    const status = await getPgSupervisorStatus();
    expect(status.failureKind).toBeNull();
  });
});

describe('getPgSupervisorStatus — the retired attach state (#3194 ST-3)', () => {
  it('a FOREIGN payload still reporting `attached` fails the narrowed guard and reads the neutral default', async () => {
    // A foreign/older backend payload: the attach state no longer exists in the
    // union, so the closed `isSupervisorState` guard rejects the whole snapshot.
    setInvoke(async () => ({ state: 'attached', port: 54321, pid: 42 }));

    const status = await getPgSupervisorStatus();
    // The neutral default — NEVER a false `failed`/`down` (G-220).
    expect(status).toEqual({ state: 'disabled' });
    expect(status.state).not.toBe('failed');
  });

  it('accepts every surviving state (disabled / starting / ready / failed)', async () => {
    for (const state of ['disabled', 'starting', 'ready', 'failed'] as const) {
      setInvoke(async () => ({ state, port: null, pid: null, error: null }));
      const status = await getPgSupervisorStatus();
      expect(status.state).toBe(state);
    }
  });
});
