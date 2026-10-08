/**
 * Application-data store pins — Spec #2896 ST-5 (R-1.2 / R-2 / R-3).
 *
 * Pins the merge semantics the RTDB row store proved, applied to the
 * application-owned data layer:
 *  - insert = spread-merge (init-time fields survive),
 *  - update = `{ ...row, ...values }`,
 *  - remove = drop,
 *  - the per-record version guard drops any notification at/below the last
 *    applied version (a read/watch snapshot seeds that version — R-1.2),
 *  - `epoch` advances ONLY on a real mutation (never on a stale drop, a
 *    content no-op, or an absent remove).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyApplicationDeliveries,
  applyApplicationNotification,
  applicationRefKey,
  getApplicationEpoch,
  getApplicationNotifications,
  getApplicationRows,
  resetApplicationDataStoreForTests,
  seedApplicationRows,
} from '../store';
import type { DataTableRef, ApplicationDataRow } from '../client';
import type { ApplicationChangeKind, ApplicationRowNotification } from '../../classes/EventSubscription';

const APPLICATION_REF: DataTableRef = { source: 'application', applicationId: 'mission-monitor', table: 'sessions' };
const CANONICAL_REF: DataTableRef = { source: 'canonical', table: 'chat' };

let watchCounter = 0;

function notification(
  overrides: Partial<ApplicationRowNotification> & {
    kind: ApplicationChangeKind;
    version: number;
  },
): ApplicationRowNotification {
  watchCounter += 1;
  return {
    watchId: `w-${watchCounter}`,
    applicationId: 'mission-monitor',
    table: 'sessions',
    key: ['ses_1'],
    changedFields: [],
    values: null,
    timestamp: '2026-09-18T00:00:00+00:00',
    ...overrides,
  };
}

/** Rows are keyed by `JSON.stringify(primaryKeyValues)` — mirror the store. */
const RECORD_KEY = JSON.stringify(['ses_1']);

function row(ref: DataTableRef, key = RECORD_KEY): ApplicationDataRow | undefined {
  return getApplicationRows(ref).get(key);
}

describe('application-data store', () => {
  beforeEach(() => {
    resetApplicationDataStoreForTests();
    watchCounter = 0;
  });

  it('insert spread-merges so init-time fields survive a later insert', () => {
    applyApplicationNotification(
      notification({
        kind: 'insert',
        version: 1,
        values: { sessionId: 'ses_1', derivedName: 'first prompt', _rowVersion: 1 },
      }),
    );
    // A replayed insert carrying only the changed field must NOT wipe the
    // init-time `derivedName`.
    applyApplicationNotification(
      notification({
        kind: 'insert',
        version: 2,
        changedFields: ['customName'],
        values: { customName: 'renamed', _rowVersion: 2 },
      }),
    );

    expect(row(APPLICATION_REF)).toMatchObject({
      sessionId: 'ses_1',
      derivedName: 'first prompt',
      customName: 'renamed',
      _rowVersion: 2,
    });
  });

  it('update merges `{ ...row, ...patch }` and reports the changed field', () => {
    applyApplicationNotification(
      notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1', customName: 'a' } }),
    );
    applyApplicationNotification(
      notification({
        kind: 'update',
        version: 2,
        changedFields: ['customName'],
        values: { sessionId: 'ses_1', customName: 'b' },
      }),
    );
    expect(row(APPLICATION_REF)).toMatchObject({ sessionId: 'ses_1', customName: 'b' });
  });

  it('remove drops the record (no value asserted)', () => {
    applyApplicationNotification(
      notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1' } }),
    );
    expect(row(APPLICATION_REF)).toBeDefined();

    applyApplicationNotification(
      notification({ kind: 'remove', version: 2, changedFields: ['sessionId'], values: null }),
    );
    expect(row(APPLICATION_REF)).toBeUndefined();
  });

  it('version guard drops a notification at or below the last applied version (R-1.2)', () => {
    // A read/watch snapshot taken at scope version 10 seeds the store.
    seedApplicationRows(APPLICATION_REF, 10, [{ sessionId: 'ses_1', derivedName: 'snapshot' }], (r) => [
      r.sessionId as string,
    ]);
    expect(row(APPLICATION_REF)).toMatchObject({ derivedName: 'snapshot' });

    // A late notification older than the snapshot is dropped.
    applyApplicationNotification(
      notification({
        kind: 'update',
        version: 9,
        changedFields: ['derivedName'],
        values: { sessionId: 'ses_1', derivedName: 'stale' },
      }),
    );
    expect(row(APPLICATION_REF)).toMatchObject({ derivedName: 'snapshot' });

    // A notification at the same version is also dropped (the snapshot already
    // includes it — `<=`).
    applyApplicationNotification(
      notification({
        kind: 'update',
        version: 10,
        changedFields: ['derivedName'],
        values: { sessionId: 'ses_1', derivedName: 'same-version' },
      }),
    );
    expect(row(APPLICATION_REF)).toMatchObject({ derivedName: 'snapshot' });

    // A newer version applies.
    applyApplicationNotification(
      notification({
        kind: 'update',
        version: 11,
        changedFields: ['derivedName'],
        values: { sessionId: 'ses_1', derivedName: 'current' },
      }),
    );
    expect(row(APPLICATION_REF)).toMatchObject({ derivedName: 'current' });
  });

  it('epoch advances ONLY on a real mutation', () => {
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(0);

    applyApplicationNotification(
      notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1', customName: 'a' } }),
    );
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(1);

    // Content-identical update → no real mutation → no bump.
    applyApplicationNotification(
      notification({ kind: 'update', version: 2, values: { sessionId: 'ses_1', customName: 'a' } }),
    );
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(1);

    // Stale drop → no bump.
    applyApplicationNotification(
      notification({ kind: 'update', version: 2, values: { sessionId: 'ses_1', customName: 'z' } }),
    );
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(1);

    // Remove of an absent record → no bump.
    applyApplicationNotification(
      notification({ kind: 'remove', version: 3, key: ['missing'], values: null }),
    );
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(1);

    // A real update bumps exactly once.
    applyApplicationNotification(
      notification({ kind: 'update', version: 4, values: { sessionId: 'ses_1', customName: 'c' } }),
    );
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(2);

    // A real remove bumps exactly once.
    applyApplicationNotification(
      notification({ kind: 'remove', version: 5, values: null }),
    );
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(3);
  });

  it('a batch bumps each touched partition at most ONCE per batch', () => {
    applyApplicationDeliveries([
      notification({ kind: 'insert', version: 1, key: ['a'], values: { sessionId: 'a' } }),
      notification({ kind: 'insert', version: 1, key: ['b'], values: { sessionId: 'b' } }),
      notification({ kind: 'insert', version: 1, key: ['c'], values: { sessionId: 'c' } }),
    ]);
    expect(getApplicationRows(APPLICATION_REF).size).toBe(3);
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(1);
  });

  it('keys partitions by table ref — canonical watches route to their own partition', () => {
    applyApplicationNotification(
      notification({
        kind: 'insert',
        version: 5,
        applicationId: null,
        table: 'chat',
        key: ['ses_1_2', 'ses_1'],
        values: { sessionId: 'ses_1', correlationId: 'ses_1_2', agentReply: 'hi' },
      }),
    );
    expect(getApplicationRows(CANONICAL_REF).size).toBe(1);
    expect(getApplicationRows(APPLICATION_REF).size).toBe(0);
    expect(applicationRefKey(CANONICAL_REF)).toBe('canonical:chat');
    expect(applicationRefKey(APPLICATION_REF)).toBe('application:mission-monitor:sessions');
  });

  it('snapshot seeding preserves newer applied notifications (never regresses)', () => {
    applyApplicationNotification(
      notification({
        kind: 'insert',
        version: 20,
        values: { sessionId: 'ses_1', derivedName: 'live' },
      }),
    );
    // A read snapshot from an older scope version must not overwrite it.
    seedApplicationRows(APPLICATION_REF, 15, [{ sessionId: 'ses_1', derivedName: 'old-read' }], (r) => [
      r.sessionId as string,
    ]);
    expect(row(APPLICATION_REF)).toMatchObject({ derivedName: 'live' });

    // ...but a newer snapshot does seed the store.
    seedApplicationRows(APPLICATION_REF, 21, [{ sessionId: 'ses_1', derivedName: 'fresh-read' }], (r) => [
      r.sessionId as string,
    ]);
    expect(row(APPLICATION_REF)).toMatchObject({ derivedName: 'fresh-read' });
  });

  it('records every received notification in the probe log with its applied flag', () => {
    applyApplicationNotification(notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1' } }));
    applyApplicationNotification(notification({ kind: 'update', version: 1, values: { sessionId: 'ses_1', customName: 'x' } }));

    const log = getApplicationNotifications();
    expect(log).toHaveLength(2);
    expect(log[0].applied).toBe(true);
    expect(log[1].applied).toBe(false); // stale (version 1 <= last applied 1)
    expect(log[1].changedFields).toEqual([]);
  });
});
