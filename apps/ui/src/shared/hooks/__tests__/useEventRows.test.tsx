/**
 * useEventRows unit tests — Spec #2788 P4.1.
 *
 * Covers: query-text building, subscribe_events invocation (replay/flushMs),
 * row apply semantics (insert/update spread-merge/remove), epoch advancing
 * only on real mutation, seq-based stale-patch handling, loud subscribe
 * error surfacing (R-3a), re-subscribe on args change, unsubscribe on unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: vi.fn(),
    llmChat: vi.fn(),
    llmChatWithImage: vi.fn(),
  },
}));

import { useEventRows, buildQueryText } from '../useEventRows';
import {
  applyRowDelivery,
  endReplayDrain,
  resetRowStoreForTests,
  getRowEpoch,
  getRowMap,
} from '../../contexts/StreamContext';
import { rowKeyString } from '../../classes/EventSubscription';
import type { RowDelivery, RowChangeKind } from '../../classes/EventSubscription';

function chatDelivery(
  overrides: Partial<RowDelivery> & { kind: RowChangeKind; seq: number },
): RowDelivery {
  return {
    queryId: 'q-test',
    eventType: 'Chat',
    key: { sessionId: 'ses_a', correlationId: 'ses_a_1' },
    patch: null,
    timestamp: '2026-09-01T00:00:00+00:00',
    ...overrides,
  };
}

const FULL_CHAT_PATCH = {
  sessionId: 'ses_a',
  correlationId: 'ses_a_1',
  seq: 1,
  startedAtNs: 1000,
  endedAtNs: null,
  updatedAt: '2026-09-01T00:00:00+00:00',
  state: 'Init' as const,
  userMessage: 'hello',
  agentReply: null,
  promptTokens: 12,
  completionTokens: null,
  cacheReadTokens: null,
  costUsd: null,
  model: 'gpt-test',
  parentSessionId: null,
  compositedChildSessionId: null,
  rawJson: '{}',
};

const KEY = rowKeyString({ sessionId: 'ses_a', correlationId: 'ses_a_1' });

describe('buildQueryText', () => {
  it('builds a session-scoped chat query with the canonical selection', () => {
    const text = buildQueryText('Chat', { sessionId: 'ses_x' });
    expect(text).toMatch(/^chat\(sessionId = "ses_x"\) \{ /);
    expect(text).toContain('sessionId, correlationId, seq');
    expect(text).toContain('userMessage, agentReply');
    expect(text).toContain('parentSessionId, compositedChildSessionId, rawJson');
    expect(text.endsWith(' }')).toBe(true);
  });

  it('supports no-args queries (all rows of a type)', () => {
    const text = buildQueryText('ToolUse', {});
    expect(text).toMatch(/^toolUse \{ /);
  });

  it('quotes strings, leaves numbers and booleans bare, emits null bare', () => {
    expect(buildQueryText('Chat', { sessionId: 'ses_1', seq: 5 })).toContain(
      'sessionId = "ses_1", seq = 5',
    );
    expect(buildQueryText('ToolUse', { toolSuccess: true })).toContain('toolSuccess = true');
    expect(buildQueryText('ToolUse', { toolSuccess: false })).toContain('toolSuccess = false');
    expect(buildQueryText('Chat', { model: null })).toContain('model = null');
  });

  it('escapes special characters in string literals', () => {
    expect(buildQueryText('Chat', { sessionId: 'ses_"x' })).toContain('sessionId = "ses_\\"x"');
  });
});

describe('useEventRows — subscription lifecycle', () => {
  beforeEach(() => {
    resetRowStoreForTests();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([{ queryId: 'q-1', eventType: 'Chat' }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls subscribe_events with the built query text, replay and flushMs', async () => {
    const { result } = renderHook(() =>
      useEventRows('Chat', { sessionId: 'ses_1' }, { replay: true, flushMs: 0 }),
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'subscribe_events',
        expect.objectContaining({ replay: true, flushMs: 0 }),
      );
    });
    const query = invokeMock.mock.calls[0][1].queries[0] as string;
    expect(query).toBe(buildQueryText('Chat', { sessionId: 'ses_1' }));
    expect(result.current.error).toBeNull();
  });

  it('omits flushMs from the invoke args when not provided', async () => {
    renderHook(() => useEventRows('Chat', { sessionId: 'ses_1' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('subscribe_events', expect.any(Object));
    });
    const args = invokeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(args).toEqual({
      queries: [buildQueryText('Chat', { sessionId: 'ses_1' })],
      replay: false,
    });
  });

  it('resubscribes on args change: unsubscribes the old queryId, subscribes anew', async () => {
    invokeMock
      .mockResolvedValueOnce([{ queryId: 'q-old', eventType: 'Chat' }])
      .mockResolvedValueOnce([{ queryId: 'q-new', eventType: 'Chat' }]);

    const { rerender, unmount } = renderHook(
      ({ sessionId }: { sessionId: string }) => useEventRows('Chat', { sessionId }),
      { initialProps: { sessionId: 'ses_1' } },
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('subscribe_events', expect.any(Object));
    });

    rerender({ sessionId: 'ses_2' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('unsubscribe_events', { queryIds: ['q-old'] });
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(3);
    });
    const secondQuery = invokeMock.mock.calls[2][1].queries[0] as string;
    expect(secondQuery).toBe(buildQueryText('Chat', { sessionId: 'ses_2' }));
    unmount();
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_1' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('subscribe_events', expect.any(Object));
    });
    unmount();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('unsubscribe_events', { queryIds: ['q-1'] });
    });
  });

  it('unsubscribes when unmounted before the subscribe promise resolves', async () => {
    let resolveSubscribe: (v: Array<{ queryId: string; eventType: string }>) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }),
    );

    const { unmount } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_1' }));
    unmount();

    resolveSubscribe([{ queryId: 'q-late', eventType: 'Chat' }]);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('unsubscribe_events', { queryIds: ['q-late'] });
    });
  });

  it('surfaces subscribe errors loudly: verbatim backend text + console.error (R-3a)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const backendError = 'unknown field: bogus — in: chat(bogus = 1) { sessionId, ... }';
    invokeMock.mockRejectedValueOnce([backendError]);

    const { result } = renderHook(() => useEventRows('Chat', { bogus: 1 } as never));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error).toBe(backendError);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0]).toContain('subscribe_events failed');
    expect(consoleSpy.mock.calls[0][0]).toContain('chat(bogus = 1)');
    expect(consoleSpy.mock.calls[0][1]).toBe(backendError);
    // No rows, no epoch advance on failure.
    expect(result.current.epoch).toBe(0);
    expect(result.current.rows.size).toBe(0);
  });

  it('clears a previous error after a successful resubscribe', async () => {
    const backendError = 'bad query — in: chat(x = 1) { ... }';
    invokeMock
      .mockRejectedValueOnce([backendError])
      .mockResolvedValueOnce([{ queryId: 'q-2', eventType: 'Chat' }]);

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useEventRows('Chat', { sessionId }),
      { initialProps: { sessionId: 'bad' } },
    );

    await waitFor(() => {
      expect(result.current.error).toBe(backendError);
    });

    rerender({ sessionId: 'good' });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });
});

describe('useEventRows — ready resolves on the replay-completion marker (round-3 F-33)', () => {
  beforeEach(() => {
    resetRowStoreForTests();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([{ queryId: 'q-1', eventType: 'Chat' }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ready does NOT resolve on subscribe return alone (replay: true)', async () => {
    const { result } = renderHook(() => useEventRows('Chat', {}, { replay: true }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('subscribe_events', expect.any(Object));
    });
    await act(async () => {}); // flush the subscribe promise
    expect(result.current.error).toBeNull();
    expect(result.current.ready).toBe(false, 'subscribe resolution is NOT the settle signal');

    act(() => {
      // The backend's replayCompleteQueryId marker for THIS query id arrives
      // (normally routed by AppProvider → endReplayDrain).
      endReplayDrain('q-1');
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
  });

  it('ready resolves only on the MATCHING marker — a foreign queryId settles nothing', async () => {
    const { result } = renderHook(() => useEventRows('Chat', {}, { replay: true }));

    await act(async () => {});
    act(() => {
      endReplayDrain('q-foreign');
    });
    expect(result.current.ready).toBe(false, 'a foreign marker settles nothing');

    act(() => {
      endReplayDrain('q-1');
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
  });

  it('replay: false still resolves ready on subscribe resolution (no marker will ever exist)', async () => {
    const { result } = renderHook(() => useEventRows('Chat', {}));
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(result.current.error).toBeNull();
  });

  it('a subscribe failure keeps ready false and surfaces the error (gate opens on error)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(['bad query']);
    const { result } = renderHook(() => useEventRows('Chat', {}, { replay: true }));

    await waitFor(() => {
      expect(result.current.error).toBe('bad query');
    });
    expect(result.current.ready).toBe(false);
    consoleSpy.mockRestore();
  });

  it('unmount before the marker cancels the drain — later batches bump per-batch again', async () => {
    const { unmount } = renderHook(() => useEventRows('Chat', {}, { replay: true }));
    await act(async () => {});
    unmount();

    // The drain was cancelled on cleanup: a batch bumps per-batch again
    // (no pending drain defers it).
    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }));
    });
    expect(getRowEpoch('Chat')).toBe(1);

    // A late marker for the cancelled query neither throws nor wedges.
    expect(() => endReplayDrain('q-1')).not.toThrow();
  });
});

describe('useEventRows — row store semantics', () => {
  beforeEach(() => {
    resetRowStoreForTests();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([{ queryId: 'q-1', eventType: 'Chat' }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('insert sets the full row and advances the epoch', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    expect(result.current.epoch).toBe(0);
    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }));
    });

    expect(result.current.epoch).toBe(1);
    const row = result.current.rows.get(KEY);
    expect(row).toBeDefined();
    expect(row?.userMessage).toBe('hello');
    expect(row?.state).toBe('Init');
  });

  it('update patch merges into the existing row — init-time fields survive', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }));
    });
    act(() => {
      applyRowDelivery(
        chatDelivery({
          kind: 'update',
          seq: 2,
          patch: { agentReply: 'hi there', state: 'Response', completionTokens: 34 },
        }),
      );
    });

    const row = result.current.rows.get(KEY);
    expect(row?.userMessage).toBe('hello'); // init-time data survives
    expect(row?.agentReply).toBe('hi there');
    expect(row?.completionTokens).toBe(34);
    expect(row?.state).toBe('Response');
    expect(row?.promptTokens).toBe(12);
    expect(result.current.epoch).toBe(2);
  });

  it('a patch that changes nothing does NOT advance the epoch', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }));
    });
    const epochAfterInsert = result.current.epoch;

    act(() => {
      applyRowDelivery(
        chatDelivery({ kind: 'update', seq: 2, patch: { userMessage: 'hello' } }),
      );
    });

    expect(result.current.epoch).toBe(epochAfterInsert);
  });

  it('insert on an existing key spread-merges — fields the patch omits are never wiped', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 3, patch: FULL_CHAT_PATCH }));
    });
    // Subset-selection re-insert: the patch omits userMessage entirely
    // (e.g. a narrower selection projection), so the earlier value survives.
    const { userMessage: _omitted, ...subsetPatch } = FULL_CHAT_PATCH;
    act(() => {
      applyRowDelivery(
        chatDelivery({
          kind: 'insert',
          seq: 3,
          patch: { ...subsetPatch, agentReply: 'replayed reply' },
        }),
      );
    });

    const row = result.current.rows.get(KEY);
    expect(row?.userMessage).toBe('hello'); // never wiped by the field-omitting re-insert
    expect(row?.agentReply).toBe('replayed reply');
  });

  it('drops a stale update whose seq is lower than the last applied seq for the key', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }));
    });
    act(() => {
      applyRowDelivery(
        chatDelivery({ kind: 'update', seq: 5, patch: { agentReply: 'latest' } }),
      );
    });
    const epochBefore = result.current.epoch;

    act(() => {
      applyRowDelivery(
        chatDelivery({ kind: 'update', seq: 3, patch: { agentReply: 'stale' } }),
      );
    });

    expect(result.current.rows.get(KEY)?.agentReply).toBe('latest');
    expect(result.current.epoch).toBe(epochBefore); // no mutation, no epoch bump
  });

  it('applies an equal-seq update (coalesced duplicate seqs are not stale)', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 4, patch: FULL_CHAT_PATCH }));
    });
    act(() => {
      applyRowDelivery(
        chatDelivery({ kind: 'update', seq: 4, patch: { agentReply: 'coalesced' } }),
      );
    });

    expect(result.current.rows.get(KEY)?.agentReply).toBe('coalesced');
  });

  it('adopts an update arriving before any insert as the baseline row', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(
        chatDelivery({ kind: 'update', seq: 2, patch: { agentReply: 'early', seq: 2 } }),
      );
    });

    expect(result.current.epoch).toBe(1);
    expect(result.current.rows.get(KEY)?.agentReply).toBe('early');
  });

  it('remove deletes the row; removing an absent key does not advance the epoch', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }));
    });
    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'remove', seq: 2, patch: null }));
    });

    expect(result.current.rows.has(KEY)).toBe(false);
    expect(getRowEpoch('Chat')).toBe(2);

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'remove', seq: 2, patch: null }));
    });
    expect(getRowEpoch('Chat')).toBe(2); // no mutation
  });

  it('replay replaces hydration: re-inserting rows resets their content', () => {
    const { result } = renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(
        chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }),
      );
    });
    act(() => {
      applyRowDelivery(
        chatDelivery({ kind: 'update', seq: 2, patch: { agentReply: 'live value' } }),
      );
    });

    act(() => {
      // Replay snapshot re-inserts the row with persisted content.
      applyRowDelivery(
        chatDelivery({
          kind: 'insert',
          seq: 2,
          patch: { ...FULL_CHAT_PATCH, agentReply: 'persisted reply', state: 'Response' },
        }),
      );
    });

    const row = result.current.rows.get(KEY);
    expect(row?.agentReply).toBe('persisted reply');
    expect(row?.userMessage).toBe('hello'); // init-time field survives spread-merge
    expect(result.current.rows.size).toBe(1);
  });

  it('partitions rows by eventType — Chat rows never leak into ToolUse', () => {
    renderHook(() => useEventRows('Chat', { sessionId: 'ses_a' }));

    act(() => {
      applyRowDelivery(chatDelivery({ kind: 'insert', seq: 1, patch: FULL_CHAT_PATCH }));
    });

    expect(getRowMap('Chat').size).toBe(1);
    expect(getRowMap('ToolUse').size).toBe(0);
    expect(getRowEpoch('ToolUse')).toBe(0);
  });
});
