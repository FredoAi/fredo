/**
 * useDevModeStream pin tests — Spec #2788 round-5 FM-34 fix.
 *
 * Pins the regression found by the round-4 live sweep: the Dev Mode stream
 * viewer must recompute when the row-mutation log's monotonic VERSION
 * advances (the recompute driver), not merely once at mount. The pre-fix
 * code discarded the version primitive and keyed its accumulator effect on
 * `getRowMutations()`'s array identity — which is mutated in place and never
 * re-bound, so post-mount mutations never rendered (viewer frozen at "1
 * event" while the row store kept applying deliveries).
 *
 * The second apply is the fail-before/pass-after pin: against the round-4
 * code `events.length` stays 1 after the second delivery; after the fix it
 * recomputes to 2.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactElement } from 'react';

import { StreamProvider } from '../../../../shared/contexts/StreamContext';
import {
  applyRowDelivery,
  resetRowStoreForTests,
} from '../../../../shared/contexts/StreamContext';
import type { RowDelivery, RowChangeKind } from '../../../../shared/classes/EventSubscription';
import { useDevModeStream } from '../useDevModeStream';

// ── Fixtures ────────────────────────────────────────────────────────────────

function devModeDelivery(
  overrides: Partial<RowDelivery> & { kind: RowChangeKind; seq: number },
): RowDelivery {
  return {
    queryId: 'q-devmode-test',
    eventType: 'Chat',
    key: { sessionId: 'ses_devmode', correlationId: 'ses_devmode_1' },
    patch: null,
    timestamp: '2026-09-01T00:00:00+00:00',
    ...overrides,
  };
}

function fullChatPatch(seq: number) {
  return {
    sessionId: 'ses_devmode',
    correlationId: 'ses_devmode_1',
    seq,
    startedAtNs: 1000,
    endedAtNs: null,
    updatedAt: '2026-09-01T00:00:00+00:00',
    state: 'Init' as const,
    userMessage: 'devmode pin test',
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
}

function wrapper({ children }: { children: React.ReactNode }): ReactElement {
  return <StreamProvider>{children}</StreamProvider>;
}

// ── FM-34 pin: viewer derivation advances with the row-mutation log ─────────

describe('useDevModeStream — viewer recomputes on row-store version change (FM-34)', () => {
  beforeEach(() => {
    resetRowStoreForTests();
  });

  it('starts empty at mount', () => {
    const { result } = renderHook(() => useDevModeStream(), { wrapper });
    expect(result.current.events).toHaveLength(0);
  });

  it('accumulates the first applied delivery and projects the row', () => {
    const { result } = renderHook(() => useDevModeStream(), { wrapper });

    act(() => {
      applyRowDelivery(
        devModeDelivery({ kind: 'insert', seq: 1, patch: fullChatPatch(1) }),
      );
    });

    expect(result.current.events).toHaveLength(1);
    const ev = result.current.events[0];
    expect(ev.eventType).toBe('Chat');
    expect(ev.state).toBe('Init');
    expect(ev.sessionId).toBe('ses_devmode');
    expect(ev.correlationId).toBe('ses_devmode_1');
    expect(ev.payload).toMatchObject({ userMessage: 'devmode pin test', state: 'Init' });
  });

  it('accumulates a SECOND post-mount delivery (fail-before/pass-after pin)', () => {
    const { result } = renderHook(() => useDevModeStream(), { wrapper });

    act(() => {
      applyRowDelivery(
        devModeDelivery({ kind: 'insert', seq: 1, patch: fullChatPatch(1) }),
      );
    });
    expect(result.current.events).toHaveLength(1);

    // This is the FM-34 assertion: the pre-fix effect never re-ran after
    // mount (deps on the stable in-place-mutated array identity), so the
    // viewer froze at 1 event while the store kept applying deliveries.
    act(() => {
      applyRowDelivery(
        devModeDelivery({
          kind: 'update',
          seq: 2,
          patch: { agentReply: 'reply', state: 'Response' as const },
        }),
      );
    });

    expect(result.current.events).toHaveLength(2);
    // Newest-first: the second delivery's projection is on top.
    expect(result.current.events[0].state).toBe('Response');
    expect(result.current.events[0].payload).toMatchObject({ agentReply: 'reply' });
  });

  it('clearEvents resets the viewer and flushes the module-scoped log', () => {
    const { result } = renderHook(() => useDevModeStream(), { wrapper });

    act(() => {
      applyRowDelivery(
        devModeDelivery({ kind: 'insert', seq: 1, patch: fullChatPatch(1) }),
      );
      applyRowDelivery(
        devModeDelivery({
          kind: 'update',
          seq: 2,
          patch: { agentReply: 'reply', state: 'Response' as const },
        }),
      );
    });
    expect(result.current.events).toHaveLength(2);

    act(() => {
      result.current.clearEvents();
    });
    expect(result.current.events).toHaveLength(0);
  });
});
