/**
 * AppProvider application-data routing pins — Spec #2896 ST-5.
 *
 * The `{"applicationBatch": [...]}` envelope rides the EXISTING
 * "fredo-stream-event" channel and MUST be discriminated BEFORE the RTDB
 * `rowBatch` validators, then applied to the application-data store. RTDB row
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
  getApplicationEpoch,
  getApplicationRows,
  resetApplicationDataStoreForTests,
} from '../../../shared/application-data/store';
import { rowKeyString } from '../../../shared/classes/EventSubscription';
import type { HostAdapter } from '../../adapters/HostAdapter';
import type { DataTableRef } from '../../../shared/application-data/client';
import type { ApplicationRowNotification, RowDelivery } from '../../../shared/classes/EventSubscription';

const APPLICATION_REF: DataTableRef = {
  source: 'application',
  applicationId: 'mission-monitor',
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

const APPLICATION_NOTIFICATION: ApplicationRowNotification = {
  watchId: 'w-1',
  applicationId: 'mission-monitor',
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

describe('AppProvider — applicationBatch routing (Spec #2896 ST-5)', () => {
  beforeEach(() => {
    resetRowStoreForTests();
    resetApplicationDataStoreForTests();
  });

  it('routes a applicationBatch envelope to the application-data store (one epoch bump)', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ applicationBatch: [APPLICATION_NOTIFICATION] } as unknown as Record<string, unknown>);
    });

    expect(getApplicationRows(APPLICATION_REF).get(JSON.stringify(['ses_1']))).toMatchObject({
      customName: 'Renamed',
    });
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(1);
    // The RTDB store is untouched by a application delivery.
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
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(0);
  });

  it('rejects a malformed applicationBatch whole (never partially applied)', () => {
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
        applicationBatch: [
          APPLICATION_NOTIFICATION,
          // Malformed: a `remove` carrying values violates the R-3.4 contract.
          { ...APPLICATION_NOTIFICATION, kind: 'remove', values: { sessionId: 'ses_1' } },
        ],
      } as unknown as Record<string, unknown>);
    });

    expect(getApplicationRows(APPLICATION_REF).size).toBe(0);
    expect(getApplicationEpoch(APPLICATION_REF)).toBe(0);
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

    expect(getApplicationEpoch(APPLICATION_REF)).toBe(0);
    expect(getRowEpoch('Chat')).toBe(0);
  });
});
