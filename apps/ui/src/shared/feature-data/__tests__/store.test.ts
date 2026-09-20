/**
 * Feature-data store pins — Spec #2896 ST-5 (R-1.2 / R-2 / R-3).
 *
 * Pins the merge semantics the RTDB row store proved, applied to the
 * feature-owned data layer:
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
  applyFeatureDeliveries,
  applyFeatureNotification,
  featureRefKey,
  getFeatureEpoch,
  getFeatureNotifications,
  getFeatureRows,
  resetFeatureDataStoreForTests,
  seedFeatureRows,
} from '../store';
import type { DataTableRef, FeatureDataRow } from '../client';
import type { FeatureChangeKind, FeatureRowNotification } from '../../classes/EventSubscription';

const FEATURE_REF: DataTableRef = { source: 'feature', featureId: 'mission-monitor', table: 'sessions' };
const CANONICAL_REF: DataTableRef = { source: 'canonical', table: 'chat' };

let watchCounter = 0;

function notification(
  overrides: Partial<FeatureRowNotification> & {
    kind: FeatureChangeKind;
    version: number;
  },
): FeatureRowNotification {
  watchCounter += 1;
  return {
    watchId: `w-${watchCounter}`,
    featureId: 'mission-monitor',
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

function row(ref: DataTableRef, key = RECORD_KEY): FeatureDataRow | undefined {
  return getFeatureRows(ref).get(key);
}

describe('feature-data store', () => {
  beforeEach(() => {
    resetFeatureDataStoreForTests();
    watchCounter = 0;
  });

  it('insert spread-merges so init-time fields survive a later insert', () => {
    applyFeatureNotification(
      notification({
        kind: 'insert',
        version: 1,
        values: { sessionId: 'ses_1', derivedName: 'first prompt', _rowVersion: 1 },
      }),
    );
    // A replayed insert carrying only the changed field must NOT wipe the
    // init-time `derivedName`.
    applyFeatureNotification(
      notification({
        kind: 'insert',
        version: 2,
        changedFields: ['customName'],
        values: { customName: 'renamed', _rowVersion: 2 },
      }),
    );

    expect(row(FEATURE_REF)).toMatchObject({
      sessionId: 'ses_1',
      derivedName: 'first prompt',
      customName: 'renamed',
      _rowVersion: 2,
    });
  });

  it('update merges `{ ...row, ...patch }` and reports the changed field', () => {
    applyFeatureNotification(
      notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1', customName: 'a' } }),
    );
    applyFeatureNotification(
      notification({
        kind: 'update',
        version: 2,
        changedFields: ['customName'],
        values: { sessionId: 'ses_1', customName: 'b' },
      }),
    );
    expect(row(FEATURE_REF)).toMatchObject({ sessionId: 'ses_1', customName: 'b' });
  });

  it('remove drops the record (no value asserted)', () => {
    applyFeatureNotification(
      notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1' } }),
    );
    expect(row(FEATURE_REF)).toBeDefined();

    applyFeatureNotification(
      notification({ kind: 'remove', version: 2, changedFields: ['sessionId'], values: null }),
    );
    expect(row(FEATURE_REF)).toBeUndefined();
  });

  it('version guard drops a notification at or below the last applied version (R-1.2)', () => {
    // A read/watch snapshot taken at scope version 10 seeds the store.
    seedFeatureRows(FEATURE_REF, 10, [{ sessionId: 'ses_1', derivedName: 'snapshot' }], (r) => [
      r.sessionId as string,
    ]);
    expect(row(FEATURE_REF)).toMatchObject({ derivedName: 'snapshot' });

    // A late notification older than the snapshot is dropped.
    applyFeatureNotification(
      notification({
        kind: 'update',
        version: 9,
        changedFields: ['derivedName'],
        values: { sessionId: 'ses_1', derivedName: 'stale' },
      }),
    );
    expect(row(FEATURE_REF)).toMatchObject({ derivedName: 'snapshot' });

    // A notification at the same version is also dropped (the snapshot already
    // includes it — `<=`).
    applyFeatureNotification(
      notification({
        kind: 'update',
        version: 10,
        changedFields: ['derivedName'],
        values: { sessionId: 'ses_1', derivedName: 'same-version' },
      }),
    );
    expect(row(FEATURE_REF)).toMatchObject({ derivedName: 'snapshot' });

    // A newer version applies.
    applyFeatureNotification(
      notification({
        kind: 'update',
        version: 11,
        changedFields: ['derivedName'],
        values: { sessionId: 'ses_1', derivedName: 'current' },
      }),
    );
    expect(row(FEATURE_REF)).toMatchObject({ derivedName: 'current' });
  });

  it('epoch advances ONLY on a real mutation', () => {
    expect(getFeatureEpoch(FEATURE_REF)).toBe(0);

    applyFeatureNotification(
      notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1', customName: 'a' } }),
    );
    expect(getFeatureEpoch(FEATURE_REF)).toBe(1);

    // Content-identical update → no real mutation → no bump.
    applyFeatureNotification(
      notification({ kind: 'update', version: 2, values: { sessionId: 'ses_1', customName: 'a' } }),
    );
    expect(getFeatureEpoch(FEATURE_REF)).toBe(1);

    // Stale drop → no bump.
    applyFeatureNotification(
      notification({ kind: 'update', version: 2, values: { sessionId: 'ses_1', customName: 'z' } }),
    );
    expect(getFeatureEpoch(FEATURE_REF)).toBe(1);

    // Remove of an absent record → no bump.
    applyFeatureNotification(
      notification({ kind: 'remove', version: 3, key: ['missing'], values: null }),
    );
    expect(getFeatureEpoch(FEATURE_REF)).toBe(1);

    // A real update bumps exactly once.
    applyFeatureNotification(
      notification({ kind: 'update', version: 4, values: { sessionId: 'ses_1', customName: 'c' } }),
    );
    expect(getFeatureEpoch(FEATURE_REF)).toBe(2);

    // A real remove bumps exactly once.
    applyFeatureNotification(
      notification({ kind: 'remove', version: 5, values: null }),
    );
    expect(getFeatureEpoch(FEATURE_REF)).toBe(3);
  });

  it('a batch bumps each touched partition at most ONCE per batch', () => {
    applyFeatureDeliveries([
      notification({ kind: 'insert', version: 1, key: ['a'], values: { sessionId: 'a' } }),
      notification({ kind: 'insert', version: 1, key: ['b'], values: { sessionId: 'b' } }),
      notification({ kind: 'insert', version: 1, key: ['c'], values: { sessionId: 'c' } }),
    ]);
    expect(getFeatureRows(FEATURE_REF).size).toBe(3);
    expect(getFeatureEpoch(FEATURE_REF)).toBe(1);
  });

  it('keys partitions by table ref — canonical watches route to their own partition', () => {
    applyFeatureNotification(
      notification({
        kind: 'insert',
        version: 5,
        featureId: null,
        table: 'chat',
        key: ['ses_1_2', 'ses_1'],
        values: { sessionId: 'ses_1', correlationId: 'ses_1_2', agentReply: 'hi' },
      }),
    );
    expect(getFeatureRows(CANONICAL_REF).size).toBe(1);
    expect(getFeatureRows(FEATURE_REF).size).toBe(0);
    expect(featureRefKey(CANONICAL_REF)).toBe('canonical:chat');
    expect(featureRefKey(FEATURE_REF)).toBe('feature:mission-monitor:sessions');
  });

  it('snapshot seeding preserves newer applied notifications (never regresses)', () => {
    applyFeatureNotification(
      notification({
        kind: 'insert',
        version: 20,
        values: { sessionId: 'ses_1', derivedName: 'live' },
      }),
    );
    // A read snapshot from an older scope version must not overwrite it.
    seedFeatureRows(FEATURE_REF, 15, [{ sessionId: 'ses_1', derivedName: 'old-read' }], (r) => [
      r.sessionId as string,
    ]);
    expect(row(FEATURE_REF)).toMatchObject({ derivedName: 'live' });

    // ...but a newer snapshot does seed the store.
    seedFeatureRows(FEATURE_REF, 21, [{ sessionId: 'ses_1', derivedName: 'fresh-read' }], (r) => [
      r.sessionId as string,
    ]);
    expect(row(FEATURE_REF)).toMatchObject({ derivedName: 'fresh-read' });
  });

  it('records every received notification in the probe log with its applied flag', () => {
    applyFeatureNotification(notification({ kind: 'insert', version: 1, values: { sessionId: 'ses_1' } }));
    applyFeatureNotification(notification({ kind: 'update', version: 1, values: { sessionId: 'ses_1', customName: 'x' } }));

    const log = getFeatureNotifications();
    expect(log).toHaveLength(2);
    expect(log[0].applied).toBe(true);
    expect(log[1].applied).toBe(false); // stale (version 1 <= last applied 1)
    expect(log[1].changedFields).toEqual([]);
  });
});
