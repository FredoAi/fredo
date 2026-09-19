/**
 * AppProvider feature-data routing pins — Spec #2896 ST-5.
 *
 * The `{"featureBatch": [...]}` envelope rides the EXISTING
 * "fredo-stream-event" channel and MUST be discriminated BEFORE the RTDB
 * `rowBatch` validators, then applied to the feature-data store. RTDB row
 * deliveries keep their own path (zero regression).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

import { AppProvider } from '../AppProvider';
import {
  StreamProvider,
  resetRowStoreForTests,
  getRowEpoch,
  getRowMap,
} from '../../../shared/contexts/StreamContext';
import {
  getFeatureEpoch,
  getFeatureRows,
  resetFeatureDataStoreForTests,
} from '../../../shared/feature-data/store';
import { rowKeyString } from '../../../shared/classes/EventSubscription';
import type { HostAdapter } from '../../adapters/HostAdapter';
import type { DataTableRef } from '../../../shared/feature-data/client';
import type { FeatureRowNotification, RowDelivery } from '../../../shared/classes/EventSubscription';

const FEATURE_REF: DataTableRef = {
  source: 'feature',
  featureId: 'mission-monitor',
  table: 'sessions',
};

function makeAdapter(): {
  adapter: HostAdapter;
  dispatch: (msg: Record<string, unknown>) => void;
} {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  const adapter: HostAdapter = {
    onMessage(h: (msg: any) => void) {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    invoke: vi.fn().mockResolvedValue(undefined),
    llmChat: vi.fn().mockResolvedValue(undefined),
    llmChatWithImage: vi.fn().mockResolvedValue(undefined),
  };
  return {
    adapter,
    dispatch: (msg) => {
      if (!handler) throw new Error('onMessage handler not registered yet');
      handler(msg);
    },
  };
}

const FEATURE_NOTIFICATION: FeatureRowNotification = {
  watchId: 'w-1',
  featureId: 'mission-monitor',
  table: 'sessions',
  kind: 'update',
  key: ['ses_1'],
  changedFields: ['customName'],
  values: { sessionId: 'ses_1', customName: 'Renamed', _rowVersion: 3 },
  version: 12,
  timestamp: '2026-09-18T00:00:00+00:00',
};

const ROW_DELIVERY: RowDelivery = {
  queryId: 'q-1',
  eventType: 'Chat',
  kind: 'insert',
  seq: 1,
  key: { sessionId: 'ses_a', correlationId: 'ses_a_1' },
  patch: {
    sessionId: 'ses_a',
    correlationId: 'ses_a_1',
    seq: 1,
    state: 'Init',
    userMessage: 'hello',
    rawJson: '{}',
  } as RowDelivery['patch'],
  timestamp: '2026-09-01T00:00:00+00:00',
};

const NullProbe = () => null;

describe('AppProvider — featureBatch routing (Spec #2896 ST-5)', () => {
  beforeEach(() => {
    resetRowStoreForTests();
    resetFeatureDataStoreForTests();
  });

  it('routes a featureBatch envelope to the feature-data store (one epoch bump)', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ featureBatch: [FEATURE_NOTIFICATION] } as unknown as Record<string, unknown>);
    });

    expect(getFeatureRows(FEATURE_REF).get(JSON.stringify(['ses_1']))).toMatchObject({
      customName: 'Renamed',
    });
    expect(getFeatureEpoch(FEATURE_REF)).toBe(1);
    // The RTDB store is untouched by a feature delivery.
    expect(getRowEpoch('Chat')).toBe(0);
  });

  it('keeps RTDB rowBatch routing unchanged', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ rowBatch: [ROW_DELIVERY] } as unknown as Record<string, unknown>);
    });

    expect(getRowMap('Chat').get(rowKeyString(ROW_DELIVERY.key))?.userMessage).toBe('hello');
    expect(getRowEpoch('Chat')).toBe(1);
    expect(getFeatureEpoch(FEATURE_REF)).toBe(0);
  });

  it('rejects a malformed featureBatch whole (never partially applied)', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({
        featureBatch: [
          FEATURE_NOTIFICATION,
          // Malformed: a `remove` carrying values violates the R-3.4 contract.
          { ...FEATURE_NOTIFICATION, kind: 'remove', values: { sessionId: 'ses_1' } },
        ],
      } as unknown as Record<string, unknown>);
    });

    expect(getFeatureRows(FEATURE_REF).size).toBe(0);
    expect(getFeatureEpoch(FEATURE_REF)).toBe(0);
  });

  it('ignores unrecognized payloads', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ something: 'else' });
      dispatch(null as unknown as Record<string, unknown>);
    });

    expect(getFeatureEpoch(FEATURE_REF)).toBe(0);
    expect(getRowEpoch('Chat')).toBe(0);
  });
});
