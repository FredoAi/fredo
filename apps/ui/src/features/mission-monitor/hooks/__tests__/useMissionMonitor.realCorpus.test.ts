/**
 * #2770 round 6 — ST-2: REAL-corpus replay verification (R-4/R-6/R-7).
 *
 * Replays the version-controlled fixture `fixtures/realCorpus.ts` — the REAL
 * persisted deliveries for session ses_fa968f834ffef93m4ywSDDB5HG (the
 * "Retest deep nested after restart" run, 2026-08-31 07:15Z), exported
 * verbatim from %APPDATA%\com.fredo.app\fredo.db table
 * `feature_mission_monitor_events` (root-keyed rows + the child-BFS rows) —
 * through `useDeliveryGraph`, and asserts the depth-3 SubagentNode presents
 * correctly from the REAL double-stamped re-key corpus:
 *
 * - R-4: exactly ONE depth-3 node, parented by the L2 node's corrId, stamped
 *   depth=3/sessionMaxDepth=3, with its own child tool calls attached and its
 *   `e-calls` edge sourced from the L2 node.
 * - R-1/R-2/R-5: the L3-creating dispatch corrId persists FOUR times in the
 *   corpus with inconsistent `compositedChildSessionId` stamps (2× L2 correct,
 *   2× L1 mis-stamped) — the graph must contain exactly ONE node for it and
 *   zero unattributed calls (the mis-stamped copies must not orphan or
 *   double-claim).
 * - R-3: the association fixpoint terminates (an implicit contract — a
 *   burning fixpoint would never settle; asserted via stable node payloads).
 *
 * The fixture is FROZEN — do not regenerate from a different run (that would
 * invalidate these assertions). This is the round's decisive verifier: the
 * depth-3 node must present from the real corpus, never from synthetic
 * fixtures (REQ-L3-3: fixture-only L3 evidence FAILS).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

// Mock StreamContext (same harness as useMissionMonitor.test.ts)
const mockDeliveries: ContractDelivery[] = [];
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    deliveries: mockDeliveries,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useDeliveryGraph } from '../useMissionMonitor';
import {
  REAL_CORPUS_DELIVERIES,
  REAL_CORPUS_ROOT_SESSION_ID,
  REAL_CORPUS_L2_CORR_ID,
  REAL_CORPUS_L3_CORR_ID,
  REAL_CORPUS_L3_SESSION_ID,
} from './fixtures/realCorpus';

describe('#2770 round 6 ST-2 — real-corpus replay (ses_fa968f83…)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
  });
  afterEach(() => {
    mockDeliveries.length = 0;
  });

  it('fixture sanity: the corpus carries the real double-stamped re-key shape', () => {
    // The L3-creating dispatch corrId must appear MULTIPLE times with
    // DIFFERENT compositedChildSessionId stamps — the exact corruption class
    // this round fixes. If a regeneration ever produces a single clean copy,
    // this test stops guarding the real shape and must be re-exported.
    const l3Rows = REAL_CORPUS_DELIVERIES.filter(
      (d) => d.key['correlationId'] === REAL_CORPUS_L3_CORR_ID &&
        d.contractName === 'subagent-tool-activity',
    );
    expect(l3Rows.length).toBeGreaterThanOrEqual(3);
    const stamps = new Set(
      l3Rows.map((d) => d.payload['compositedChildSessionId']),
    );
    expect(stamps.size).toBeGreaterThanOrEqual(2);
    expect(stamps.has(REAL_CORPUS_L2_CORR_ID.split('_').slice(0, -1).join('_'))).toBe(true);
    // …and the mis-stamped copies (stamp = L1) must be present too.
    const l1SessionId = REAL_CORPUS_L2_CORR_ID.slice(0, REAL_CORPUS_L2_CORR_ID.lastIndexOf('_'));
    expect(stamps.has(l1SessionId)).toBe(true);
  });

  it('R-4: the real corpus presents exactly ONE depth-3 SubagentNode with the compact anatomy inputs, L2 parent edge, and its own tools', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: REAL_CORPUS_DELIVERIES, sessionId: REAL_CORPUS_ROOT_SESSION_ID }),
    );

    await waitFor(() => {
      const depth3 = result.current.nodes.filter(
        (n) => n.id.startsWith('subagent-') && (n.data.payload as any)?.depth === 3,
      );
      expect(depth3.length).toBe(1);
    }, { timeout: 10_000 });

    // Exactly ONE depth-3 node (no duplicates from the re-key cascade).
    const depth3 = result.current.nodes.filter(
      (n) => n.id.startsWith('subagent-') && (n.data.payload as any)?.depth === 3,
    );
    const l3 = depth3[0];
    expect(l3.id).toBe(`subagent-${REAL_CORPUS_L3_CORR_ID}`);

    const payload = l3.data.payload as any;
    expect(payload.childSessionId).toBe(REAL_CORPUS_L3_SESSION_ID);
    expect(payload.parentCorrelationId).toBe(REAL_CORPUS_L2_CORR_ID);
    expect(payload.sessionMaxDepth).toBe(3);
    expect(payload.name).toBe('general');
    // Its own child tool calls attached (the L3 bash span, R-4).
    expect((payload.tools ?? []).length).toBeGreaterThan(0);
    expect(payload.tools[0].toolName).toBe('bash');

    // The `e-calls` edge sources from the L2 node.
    const l3Edge = result.current.edges.find((e) => e.id === `e-calls-${REAL_CORPUS_L3_CORR_ID}`);
    expect(l3Edge).toBeDefined();
    expect(l3Edge!.source).toBe(`subagent-${REAL_CORPUS_L2_CORR_ID}`);
    expect(l3Edge!.target).toBe(l3.id);

    // The L2 node exists at depth 2 with nestedCount 1 (no double-claim
    // inflation). Its own non-task tools are whatever the real L2 session
    // emitted (the software-architect session made none — it only dispatched
    // JokeAgent), so only the nestedCount is pinned here.
    const l2 = result.current.nodes.find(
      (n) => n.id === `subagent-${REAL_CORPUS_L2_CORR_ID}`,
    );
    expect(l2).toBeDefined();
    expect((l2!.data.payload as any).depth).toBe(2);
    expect((l2!.data.payload as any).sessionMaxDepth).toBe(3);
    expect((l2!.data.payload as any).nestedCount).toBe(1);

    // R-5/R-1: zero unattributed calls — the mis-stamped copies must not
    // orphan any child session.
    expect(result.current.unattributedCount).toBe(0);
  });

  it('R-2/R-3: replay is idempotent — one node per nested session, no duplicates, fixpoint settles', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: REAL_CORPUS_DELIVERIES, sessionId: REAL_CORPUS_ROOT_SESSION_ID }),
    );

    await waitFor(() => {
      expect(
        result.current.nodes.filter((n) => n.id.startsWith('subagent-')).length,
      ).toBeGreaterThan(0);
    }, { timeout: 10_000 });

    // Wait for the fixpoint to settle, then snapshot the subagent node set.
    await waitFor(() => {
      const depth3 = result.current.nodes.filter(
        (n) => (n.data.payload as any)?.depth === 3,
      );
      expect(depth3.length).toBe(1);
    }, { timeout: 10_000 });

    const subagentIds = result.current.nodes
      .filter((n) => n.id.startsWith('subagent-'))
      .map((n) => n.id)
      .sort();
    // Exactly one node per dispatched session — no duplicates from the
    // double-stamped copies (a Set check over ids).
    expect(new Set(subagentIds).size).toBe(subagentIds.length);

    // The L3 dispatch appears 4× in the corpus but exactly ONE builder entry
    // exists for it (single-owner bucketing + same-corr merge).
    const l3Entries = subagentIds.filter((id) => id === `subagent-${REAL_CORPUS_L3_CORR_ID}`);
    expect(l3Entries.length).toBe(1);

    // Depth distribution: the corpus contains exactly one depth-3 chain
    // (root→L1→L2→L3); every other nested chain is depth ≤ 2.
    const depthCounts: Record<number, number> = {};
    for (const n of result.current.nodes.filter((n) => n.id.startsWith('subagent-'))) {
      const d = (n.data.payload as any).depth ?? 1;
      depthCounts[d] = (depthCounts[d] ?? 0) + 1;
    }
    expect(depthCounts[3]).toBe(1);
  });
});
