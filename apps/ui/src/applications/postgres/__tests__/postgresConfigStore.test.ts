/**
 * postgresConfigStore — the `pg_supervisor_status` consumer boundary (#3188 ST-3).
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
