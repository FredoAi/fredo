/**
 * useDeliverySessions — Spec #2896 ST-6 (declared `sessions` table migration).
 *
 * The hook no longer groups a full Chat-row replay: it reads the backend-owned
 * declared `sessions` rollup table via `useFeatureRead` (initial snapshot) +
 * `useFeatureWatch` (table-level live updates), applies the documented
 * qualification predicate over the rollup facts, and issues
 * `feature_data_delete` / `feature_data_write` for delete/rename.
 *
 * These tests mock the two consumer hooks and the feature-data client, then
 * drive the shared row map + epoch directly (the `useSyncExternalStore`
 * primitive the real hooks expose).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { FeatureDataRow } from '../../../../shared/feature-data/client';
import { deriveDisplayName } from '../../lib/sessionMeta';

// ── Mocked declared-table hooks (the shared partition map + epoch) ───────────
let mockRows = new Map<string, FeatureDataRow>();
let mockEpoch = 1;
let mockReadLoading = false;
let mockReadError: string | null = null;
let mockWatchError: string | null = null;
let mockWatchReady = true;

vi.mock('@/shared/hooks/useFeatureData', () => ({
  useFeatureRead: () => ({
    rows: mockRows,
    version: 1,
    error: mockReadError,
    loading: mockReadLoading,
  }),
  useFeatureWatch: () => ({
    rows: mockRows,
    epoch: mockEpoch,
    error: mockWatchError,
    ready: mockWatchReady,
  }),
}));

const mockFeatureDataDelete = vi.fn<(args: unknown) => Promise<{ deleted: boolean }>>();
const mockFeatureDataWrite = vi.fn<(args: unknown) => Promise<{ updated: number }>>();

vi.mock('@/shared/feature-data/client', () => ({
  featureDataDelete: (args: unknown) => mockFeatureDataDelete(args),
  featureDataWrite: (args: unknown) => mockFeatureDataWrite(args),
}));

import { useDeliverySessions, resetSessionHistoryForTests } from '../useSessionHistory';

/** A declared `sessions` rollup row (facts only + the feature-owned name). */
function rollupRow(
  overrides: Partial<FeatureDataRow> & { sessionId: string },
): FeatureDataRow {
  return {
    _rowVersion: 1,
    startedAtNs: null,
    latestAt: '2026-01-01T00:00:00.000Z',
    chatRowCount: 1,
    nonSubagentChatRowCount: 1,
    visibleTurnCount: 1,
    userDispatchCount: 0,
    derivedName: null,
    agentName: null,
    customName: null,
    ...overrides,
  };
}

function setRows(rows: FeatureDataRow[], epoch = 1): void {
  mockRows = new Map(rows.map((row) => [JSON.stringify([row.sessionId]), row]));
  mockEpoch = epoch;
}

describe('useDeliverySessions (Spec #2896 ST-6 — declared sessions table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionHistoryForTests();
    mockReadLoading = false;
    mockReadError = null;
    mockWatchError = null;
    mockWatchReady = true;
    setRows([]);
    mockFeatureDataDelete.mockResolvedValue({ deleted: true });
    mockFeatureDataWrite.mockResolvedValue({ updated: 1 });
  });

  it('renders the declared rollup rows on the first read round-trip (S0)', async () => {
    setRows([
      rollupRow({
        sessionId: 'session-a',
        startedAtNs: 1_700_000_000_000 * 1e6,
        latestAt: '2026-01-01T10:00:00.000Z',
        chatRowCount: 5,
        derivedName: '  Fix   the auth bug  ',
      }),
      rollupRow({
        sessionId: 'session-b',
        startedAtNs: 1_600_000_000_000 * 1e6,
        latestAt: '2025-12-01T10:00:00.000Z',
        chatRowCount: 3,
      }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    const a = result.current.sessions.find((s) => s.sessionId === 'session-a')!;
    // deliveryCount = chatRowCount (the rollup's authoritative count).
    expect(a.deliveryCount).toBe(5);
    // The derived name is normalized into its display form (single pipeline).
    expect(a.derivedName).toBe('Fix the auth bug');
    expect(a.latestTimestamp).toBe('2026-01-01T10:00:00.000Z');
  });

  it('sorts newest-first by latestAt (byte-identical to the previous sort)', async () => {
    setRows([
      rollupRow({ sessionId: 'old', latestAt: '2024-01-01T00:00:00.000Z' }),
      rollupRow({ sessionId: 'new', latestAt: '2024-06-01T00:00:00.000Z' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['new', 'old']);
  });

  // ── Qualification predicate (Architect A-11) ───────────────────────────────

  it('excludes a rollup row that does not qualify (no visible turn, no dispatch)', async () => {
    setRows([
      rollupRow({ sessionId: 'quiet', visibleTurnCount: 0, nonSubagentChatRowCount: 0, userDispatchCount: 0 }),
      rollupRow({ sessionId: 'visible', visibleTurnCount: 2 }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.sessions[0].sessionId).toBe('visible');
  });

  it('excludes a dispatch-less session with non-subagent rows (second predicate arm requires BOTH)', async () => {
    setRows([
      rollupRow({
        sessionId: 'no-dispatch',
        visibleTurnCount: 0,
        nonSubagentChatRowCount: 3,
        userDispatchCount: 0,
      }),
      rollupRow({
        sessionId: 'dispatch-only',
        visibleTurnCount: 0,
        nonSubagentChatRowCount: 2,
        userDispatchCount: 1,
      }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.sessions[0].sessionId).toBe('dispatch-only');
  });

  // ── Search / names ─────────────────────────────────────────────────────────

  it('filters by sessionId and by the display name (custom > derived > label)', async () => {
    setRows([
      rollupRow({ sessionId: 'my-session', derivedName: 'deepseek latency regression' }),
      rollupRow({ sessionId: 'other-session', customName: 'My Renamed Session' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => result.current.setSearchFilter('deepseek'));
    expect(result.current.filteredSessions.map((s) => s.sessionId)).toEqual(['my-session']);

    act(() => result.current.setSearchFilter('renamed'));
    expect(result.current.filteredSessions.map((s) => s.sessionId)).toEqual(['other-session']);

    act(() => result.current.setSearchFilter('session-id-that-does-not-exist'));
    expect(result.current.filteredSessions).toHaveLength(0);
  });

  it('customName is authoritative over derivedName in deriveDisplayName', async () => {
    setRows([
      rollupRow({ sessionId: 's', derivedName: 'old derived', customName: 'My Custom Name' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    const session = result.current.sessions[0];
    expect(session.derivedName).toBe('old derived');
    expect(session.customName).toBe('My Custom Name');
    expect(deriveDisplayName(session)).toBe('My Custom Name');
  });

  // ── Selection ──────────────────────────────────────────────────────────────

  it('auto-selects the newest session by START time, and supports explicit selection', async () => {
    setRows([
      // Newer start, older latestAt — start time wins for auto-select.
      rollupRow({ sessionId: 'newer-start', startedAtNs: 2000 * 1e6, latestAt: '2024-01-01T00:00:00.000Z' }),
      rollupRow({ sessionId: 'older-start', startedAtNs: 1000 * 1e6, latestAt: '2024-06-01T00:00:00.000Z' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    expect(result.current.selectedSessionId).toBe('newer-start');

    act(() => result.current.selectSession('older-start'));
    expect(result.current.selectedSessionId).toBe('older-start');
    expect(result.current.userPickedRef.current).toBe(true);
  });

  it('clears the selection when the selected session is removed from the declared table (S4 fallback)', async () => {
    setRows([rollupRow({ sessionId: 'only', startedAtNs: 2000 * 1e6 })]);

    const { result, rerender } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.selectedSessionId).toBe('only');

    // The backend removed the row (retention eviction / external delete) and
    // no other session remains — the panel falls back to S4 `NoSessionSelected`.
    setRows([], 2);
    rerender();

    await waitFor(() => expect(result.current.selectedSessionId).toBeNull());
    expect(result.current.sessions).toEqual([]);
  });

  it('follows a NEWLY-STARTED session (a new declared row) while following is armed', async () => {
    setRows([rollupRow({ sessionId: 'session-old', startedAtNs: 1000 * 1e6 })]);

    const { result, rerender } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.selectedSessionId).toBe('session-old'));
    expect(result.current.userPickedRef.current).toBe(false);

    setRows(
      [
        rollupRow({ sessionId: 'session-old', startedAtNs: 1000 * 1e6 }),
        rollupRow({
          sessionId: 'ses-live-new',
          startedAtNs: 3000 * 1e6,
          latestAt: '2026-02-01T00:00:00.000Z',
        }),
      ],
      2,
    );
    rerender();

    await waitFor(() => expect(result.current.selectedSessionId).toBe('ses-live-new'));
    expect(result.current.userPickedRef.current).toBe(false);
  });

  it('does NOT steal focus after an explicit user pick', async () => {
    setRows([
      rollupRow({ sessionId: 'a', startedAtNs: 2000 * 1e6 }),
      rollupRow({ sessionId: 'b', startedAtNs: 1000 * 1e6 }),
    ]);

    const { result, rerender } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    expect(result.current.selectedSessionId).toBe('a');

    act(() => result.current.selectSession('b'));
    expect(result.current.userPickedRef.current).toBe(true);

    setRows(
      [
        rollupRow({ sessionId: 'a', startedAtNs: 2000 * 1e6 }),
        rollupRow({ sessionId: 'b', startedAtNs: 1000 * 1e6 }),
        rollupRow({ sessionId: 'newcomer', startedAtNs: 4000 * 1e6, latestAt: '2026-03-01T00:00:00.000Z' }),
      ],
      2,
    );
    rerender();

    await waitFor(() =>
      expect(result.current.sessions.some((s) => s.sessionId === 'newcomer')).toBe(true),
    );
    expect(result.current.selectedSessionId).toBe('b');
  });

  // ── Delete / rename ────────────────────────────────────────────────────────

  it('deleteSession issues feature_data_delete and immediately drops the row (anti-resurrection)', async () => {
    setRows([rollupRow({ sessionId: 'session-a', startedAtNs: 1000 * 1e6 })]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.selectedSessionId).toBe('session-a');

    await act(async () => {
      await result.current.deleteSession('session-a');
    });

    expect(mockFeatureDataDelete).toHaveBeenCalledWith({
      ref: { featureId: 'mission-monitor', table: 'sessions' },
      key: ['session-a'],
    });
    // Optimistically suppressed — the backend `remove` notification then drops
    // the row from the shared partition (the durable tombstone behind it).
    expect(result.current.sessions).toEqual([]);
    expect(result.current.selectedSessionId).toBeNull();
    expect(result.current.userPickedRef.current).toBe(false);
  });

  it('renameSession writes the feature-owned customName column and re-derives on the update notification', async () => {
    setRows([rollupRow({ sessionId: 'session-a', derivedName: 'old derived' })]);

    const { result, rerender } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await act(async () => {
      await result.current.renameSession('session-a', '  Renamed!  ');
    });

    expect(mockFeatureDataWrite).toHaveBeenCalledWith({
      ref: { featureId: 'mission-monitor', table: 'sessions' },
      key: ['session-a'],
      set: { customName: 'Renamed!' },
    });

    // The backend `update` notification lands (same row, new customName).
    setRows([rollupRow({ sessionId: 'session-a', derivedName: 'old derived', customName: 'Renamed!' })], 2);
    rerender();

    await waitFor(() =>
      expect(result.current.sessions[0].customName).toBe('Renamed!'),
    );
    expect(deriveDisplayName(result.current.sessions[0])).toBe('Renamed!');
  });

  it('renameSession clears the custom name on an empty/whitespace save', async () => {
    setRows([rollupRow({ sessionId: 'session-a', derivedName: 'Derived Name', customName: 'Old' })]);

    const { result } = renderHook(() => useDeliverySessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await act(async () => {
      await result.current.renameSession('session-a', '   ');
    });

    expect(mockFeatureDataWrite).toHaveBeenCalledWith({
      ref: { featureId: 'mission-monitor', table: 'sessions' },
      key: ['session-a'],
      set: { customName: null },
    });
  });

  // ── S5 / S6 state contract ─────────────────────────────────────────────────

  it('settled is false while the read is loading and the watch is not ready (S5 pre-read)', async () => {
    mockReadLoading = true;
    mockWatchReady = false;
    setRows([]);

    const { result } = renderHook(() => useDeliverySessions());

    expect(result.current.settled).toBe(false);
    expect(result.current.sessions).toEqual([]);
  });

  it('settled flips true once the watch snapshot resolves, even before the read settles', async () => {
    mockReadLoading = true;
    mockWatchReady = false;
    setRows([]);

    const { result, rerender } = renderHook(() => useDeliverySessions());
    expect(result.current.settled).toBe(false);

    mockWatchReady = true;
    rerender();
    expect(result.current.settled).toBe(true);
  });

  it('surfaces the verbatim read/watch error (A-13 / S6), never swallowing it', async () => {
    mockReadError = 'feature_data_read failed: table sessions is not declared';
    setRows([]);

    const { result } = renderHook(() => useDeliverySessions());
    expect(result.current.error).toBe(
      'feature_data_read failed: table sessions is not declared',
    );
  });

  it('exposes a warm store immediately — rows resident before the read settles still render (S0 warm reopen)', async () => {
    // Warm reopen: the module-scoped partition already holds the rows while the
    // read is in flight and the watch snapshot has not resolved.
    mockReadLoading = true;
    mockWatchReady = false;
    setRows([rollupRow({ sessionId: 'warm', startedAtNs: 1000 * 1e6 })]);

    const { result } = renderHook(() => useDeliverySessions());

    // The list is already populated on the FIRST render — no spinner phase.
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['warm']);
    expect(result.current.settled).toBe(false);
  });
});
