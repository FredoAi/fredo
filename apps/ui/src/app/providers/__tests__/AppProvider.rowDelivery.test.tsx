/**
 * AppProvider RowDelivery routing tests — Spec #2788 P4.1 (P5.1: RTDB only).
 *
 * Verifies the routing contract on the shared "fredo-stream-event" channel
 * (the v1 ContractDelivery leg was deleted in P5.1 — RTDB row deliveries are
 * the ONLY event path):
 *  - RowDelivery envelopes → routed to the RTDB row store.
 *  - Batch envelopes → the bulk path (one epoch bump per touched partition).
 *  - Unrecognized payloads → ignored (pre-existing behavior).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

import { AppProvider } from '../AppProvider';
import {
  StreamProvider,
  beginReplayDrain,
  cancelReplayDrain,
  resetRowStoreForTests,
  getRowEpoch,
  getRowMap,
} from '../../../shared/contexts/StreamContext';
import { rowKeyString } from '../../../shared/classes/EventSubscription';
import type { HostAdapter } from '../../adapters/HostAdapter';
import type { RowDelivery } from '../../../shared/classes/EventSubscription';

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

const NullProbe = () => null;

describe('AppProvider — RowDelivery routing', () => {
  beforeEach(() => {
    resetRowStoreForTests();
  });

  it('routes RowDelivery envelopes to the row store', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch(ROW_DELIVERY as unknown as Record<string, unknown>);
    });

    const key = rowKeyString(ROW_DELIVERY.key);
    expect(getRowMap('Chat').get(key)?.userMessage).toBe('hello from rtdb');
    expect(getRowEpoch('Chat')).toBe(1);
  });

  it('ignores unrecognized payloads (no routing)', () => {
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
      dispatch(null);
    });

    expect(getRowEpoch('Chat')).toBe(0);
  });

  it('rejects malformed RowDelivery envelopes (missing seq/kind) without mutating the store', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ queryId: 'q-1', eventType: 'Chat', key: { sessionId: 'a', correlationId: 'b' } });
      dispatch({ queryId: 'q-1', kind: 'bogus', seq: 1, eventType: 'Chat', key: { sessionId: 'a', correlationId: 'b' } });
    });

    expect(getRowEpoch('Chat')).toBe(0);
  });

  // ── Batch envelopes (Spec #2788 F-33 fix, W-2) ──────────────────────────

  it('routes a {"rowBatch": [...]} envelope through the bulk path — rows land with ONE epoch bump', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    const batch = {
      rowBatch: [
        { ...ROW_DELIVERY, key: { sessionId: 'ses_a', correlationId: 'c1' } },
        { ...ROW_DELIVERY, key: { sessionId: 'ses_a', correlationId: 'c2' } },
        { ...ROW_DELIVERY, key: { sessionId: 'ses_a', correlationId: 'c3' } },
      ],
    };

    act(() => {
      dispatch(batch as unknown as Record<string, unknown>);
    });

    expect(getRowMap('Chat').size).toBe(3, 'every batch element applied');
    expect(getRowEpoch('Chat')).toBe(1, 'one batch → ONE epoch bump (not per delivery)');
  });

  it('still routes single RowDelivery envelopes alongside batches (backward compatible)', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    act(() => {
      dispatch({ rowBatch: [{ ...ROW_DELIVERY, key: { sessionId: 'ses_a', correlationId: 'c1' } }] } as unknown as Record<string, unknown>);
      dispatch({ ...ROW_DELIVERY, key: { sessionId: 'ses_a', correlationId: 'c2' } } as unknown as Record<string, unknown>);
    });

    expect(getRowMap('Chat').size).toBe(2);
    expect(getRowEpoch('Chat')).toBe(2, 'batch bump + single bump');
  });

  it('rejects a batch envelope carrying a malformed element without mutating the store', () => {
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
        rowBatch: [
          ROW_DELIVERY,
          { queryId: 'q-1', eventType: 'Chat', kind: 'bogus', seq: 1, key: { sessionId: 'a', correlationId: 'b' } },
        ],
      } as unknown as Record<string, unknown>);
    });

    expect(getRowMap('Chat').size).toBe(0, 'rejected whole — never partially applied');
    expect(getRowEpoch('Chat')).toBe(0);
  });

  it('routes batch and single envelopes independently — duplicate keys dedupe by row key', () => {
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
      dispatch(ROW_DELIVERY as unknown as Record<string, unknown>);
    });

    expect(getRowMap('Chat').size).toBe(1, 'same key from batch + single dedupes by row key');
    expect(getRowEpoch('Chat')).toBe(1, 'the identical re-delivered insert is a content no-op — no extra bump');
  });

  // ── Replay-completion marker (round-3 F-33 fix) ─────────────────────────

  it('applies a marker-carrying batch FIRST, then settles the drain (rows before settle)', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    beginReplayDrain('Chat', 'q-1', () => {});
    act(() => {
      dispatch({ rowBatch: [ROW_DELIVERY] } as unknown as Record<string, unknown>);
    });
    expect(getRowMap('Chat').size).toBe(1, 'rows land even while the drain is pending');
    expect(getRowEpoch('Chat')).toBe(0, 'bump deferred during the drain');

    act(() => {
      // The terminal envelope: empty rowBatch + the marker.
      dispatch({ rowBatch: [], replayCompleteQueryId: 'q-1' } as unknown as Record<string, unknown>);
    });
    expect(getRowEpoch('Chat')).toBe(1, 'ONE settle bump after the rows were applied');

    // Drain consumed: a follow-up live batch bumps per-batch again.
    act(() => {
      dispatch({ rowBatch: [{ ...ROW_DELIVERY, key: { sessionId: 'ses_a', correlationId: 'c2' } }] } as unknown as Record<string, unknown>);
    });
    expect(getRowEpoch('Chat')).toBe(2);
  });

  it('routes a batch WITHOUT a marker unchanged — the drain stays pending', () => {
    const { adapter, dispatch } = makeAdapter();
    render(
      <StreamProvider>
        <AppProvider adapter={adapter}>
          <NullProbe />
        </AppProvider>
      </StreamProvider>,
    );

    beginReplayDrain('Chat', 'q-1', () => {});
    act(() => {
      dispatch({ rowBatch: [ROW_DELIVERY] } as unknown as Record<string, unknown>);
    });
    expect(getRowMap('Chat').size).toBe(1);
    expect(getRowEpoch('Chat')).toBe(0, 'no marker → no settle');

    cancelReplayDrain('q-1');
    expect(getRowEpoch('Chat')).toBe(1, 'cancel settles the deferred mutation');
  });
});
