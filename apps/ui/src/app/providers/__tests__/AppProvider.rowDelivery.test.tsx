/**
 * AppProvider RowDelivery routing tests — Spec #2788 P4.1.
 *
 * Verifies the strangler coexistence contract on the shared
 * "fredo-stream-event" channel:
 *  - RowDelivery envelopes → routed to the RTDB row store (NOT the v1 queue).
 *  - ContractDelivery envelopes → v1 StreamContext.addDelivery — UNTOUCHED.
 *  - Unrecognized payloads → ignored (pre-existing behavior).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

import { AppProvider } from '../AppProvider';
import { StreamProvider, useStream } from '../../../shared/contexts/StreamContext';
import { resetRowStoreForTests, getRowEpoch, getRowMap } from '../../../shared/contexts/StreamContext';
import { rowKeyString } from '../../../shared/classes/EventSubscription';
import type { HostAdapter } from '../../adapters/HostAdapter';
import type { ContractDelivery, RowDelivery } from '../../../shared/classes/EventSubscription';

function makeAdapter(): { adapter: HostAdapter; dispatch: (msg: Record<string, unknown>) => void } {
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
    userMessage: 'hello from rtdb',
    rawJson: '{}',
  } as RowDelivery['patch'],
  timestamp: '2026-09-01T00:00:00+00:00',
};

const CONTRACT_DELIVERY: ContractDelivery = {
  id: 'd-1',
  contractName: 'Fredo_ui_stepper',
  lifecycle: 'init',
  key: { sessionId: 'ses_v1' },
  payload: { some: 'data' },
  timestamp: '2026-09-01T00:00:01+00:00',
};

/** Reads both pipelines so assertions can observe delivery routing. */
let probe: { v1Deliveries: number };
function Probe(): null {
  const { deliveries } = useStream();
  probe.v1Deliveries = deliveries.length;
  return null;
}

describe('AppProvider — RowDelivery vs ContractDelivery routing', () => {
  beforeEach(() => {
    resetRowStoreForTests();
    probe = { v1Deliveries: 0 };
  });

  it('routes RowDelivery envelopes to the row store, NOT the v1 delivery queue', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <Probe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch(ROW_DELIVERY as unknown as Record<string, unknown>);
    });

    const key = rowKeyString(ROW_DELIVERY.key);
    expect(getRowMap('Chat').get(key)?.userMessage).toBe('hello from rtdb');
    expect(getRowEpoch('Chat')).toBe(1);
    // v1 pipeline untouched by row deliveries.
    expect(probe.v1Deliveries).toBe(0);
  });

  it('routes ContractDelivery envelopes to the v1 addDelivery path — untouched', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <Probe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch(CONTRACT_DELIVERY as unknown as Record<string, unknown>);
    });

    expect(probe.v1Deliveries).toBe(1);
    // Row store untouched by v1 deliveries.
    expect(getRowEpoch('Chat')).toBe(0);
    expect(getRowMap('Chat').size).toBe(0);
  });

  it('routes both envelope kinds independently during coexistence', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <Probe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch(CONTRACT_DELIVERY as unknown as Record<string, unknown>);
      dispatch(ROW_DELIVERY as unknown as Record<string, unknown>);
    });

    expect(probe.v1Deliveries).toBe(1);
    expect(getRowMap('Chat').size).toBe(1);
    expect(getRowEpoch('Chat')).toBe(1);
  });

  it('ignores unrecognized payloads (no routing either way)', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <Probe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ something: 'else' });
      dispatch(null);
    });

    expect(probe.v1Deliveries).toBe(0);
    expect(getRowEpoch('Chat')).toBe(0);
  });

  it('rejects malformed RowDelivery envelopes (missing seq/kind) without mutating the store', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <Probe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ queryId: 'q-1', eventType: 'Chat', key: { sessionId: 'a', correlationId: 'b' } });
      dispatch({ queryId: 'q-1', kind: 'bogus', seq: 1, eventType: 'Chat', key: { sessionId: 'a', correlationId: 'b' } });
    });

    expect(getRowEpoch('Chat')).toBe(0);
    expect(probe.v1Deliveries).toBe(0);
  });
});
