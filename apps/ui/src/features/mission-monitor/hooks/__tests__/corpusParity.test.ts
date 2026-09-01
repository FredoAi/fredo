/**
 * corpus-parity.test.ts — P4.2 byte-parity gate on the REAL corpus (R-5a).
 *
 * The v1 delivery-driven derivation was captured BEFORE the migration into
 * `fixtures/v1Golden.json` (node set + ids, edge set, unattributed chip
 * figure, session rollups — positions excluded: they depend on measured
 * heights, not on the data path). This suite replays the same real corpus
 * (`fixtures/realCorpus.ts`) through the P4.2 TYPED-ROW path and asserts the
 * derived graph is identical — the strangler gate for R-5a:
 *
 *   "the derived graph structure (node set + ids, edge set, rollup values,
 *    chip count) must match what the v1 path produced for the same
 *    underlying data."
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

const mockDeliveries: ContractDelivery[] = [];
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({ deliveries: mockDeliveries })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useDeliveryGraph } from '../useMissionMonitor';
import { rowSource } from './rowSourceHelper';
import {
  REAL_CORPUS_DELIVERIES,
  REAL_CORPUS_ROOT_SESSION_ID,
} from './fixtures/realCorpus';
import { rowsFromDeliveries } from './fixtures/rowsFromDeliveries';
import { computeSessionMetrics } from '../../lib/counters';
import {
  computeSubagentTokenTotals,
  computeSubagentCostTotals,
} from '../../lib/sessionMeta';

const GOLDEN = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'v1Golden.json'), 'utf8'),
) as {
  nodes: Array<{ id: string; type: string; status: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
  unattributedCount: number;
  metrics: Record<string, number>;
  subagentTokens: number;
  subagentCost: number;
};

describe('P4.2 R-5a — row-path graph parity on the real corpus (ses_fa968f83…)', () => {
  it('derives the identical node set + ids and edge set as the v1 delivery path', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ rows: rowSource(REAL_CORPUS_DELIVERIES), sessionId: REAL_CORPUS_ROOT_SESSION_ID }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBe(GOLDEN.nodes.length);
    }, { timeout: 10_000 });

    // Node set + ids + types — byte-identical sets (order-independent).
    const actualNodes = result.current.nodes
      .map((n) => ({ id: n.id, type: n.type }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const expectedNodes = GOLDEN.nodes
      .map((n) => ({ id: n.id, type: n.type }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(actualNodes).toEqual(expectedNodes);

    // Edge set + ids + endpoints.
    const actualEdges = result.current.edges
      .map((e) => ({ id: e.id, source: e.source, target: e.target }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const expectedEdges = [...GOLDEN.edges]
      .map((e) => ({ id: e.id, source: e.source, target: e.target }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(actualEdges).toEqual(expectedEdges);

    // Orphan chip figure.
    expect(result.current.unattributedCount).toBe(GOLDEN.unattributedCount);
  });

  it('derives the identical session rollups (token bar + subagent shares) from typed rows', () => {
    const { chatRows, toolRows } = rowsFromDeliveries(REAL_CORPUS_DELIVERIES);
    const metrics = computeSessionMetrics(chatRows, REAL_CORPUS_ROOT_SESSION_ID);
    const subagentTokens = computeSubagentTokenTotals(toolRows, REAL_CORPUS_ROOT_SESSION_ID);
    const subagentCost = computeSubagentCostTotals(toolRows, REAL_CORPUS_ROOT_SESSION_ID);

    // The bar's five families + cost + messages — byte-identical figures.
    expect(metrics.inputTokens).toBe(GOLDEN.metrics.inputTokens);
    expect(metrics.cacheReadTokens).toBe(GOLDEN.metrics.cacheReadTokens);
    expect(metrics.cacheWriteTokens).toBe(GOLDEN.metrics.cacheWriteTokens);
    expect(metrics.reasoningTokens).toBe(GOLDEN.metrics.reasoningTokens);
    expect(metrics.outputTokens).toBe(GOLDEN.metrics.outputTokens);
    expect(metrics.totalTokens).toBe(GOLDEN.metrics.totalTokens);
    expect(metrics.totalCostUsd).toBeCloseTo(GOLDEN.metrics.totalCostUsd, 12);
    expect(metrics.totalMessages).toBe(GOLDEN.metrics.totalMessages);
    expect(subagentTokens).toBe(GOLDEN.subagentTokens);
    expect(subagentCost).toBeCloseTo(GOLDEN.subagentCost, 12);
  });
});
