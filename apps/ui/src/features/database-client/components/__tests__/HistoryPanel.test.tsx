/**
 * HistoryPanel tests (Spec #2950, ST-6; R-4.1/R-4.2/R-4.5).
 *
 * Pins newest-first ordering, the per-entry re-run that only loads SQL into a
 * tab (never executes), the tolerant empty state, and the 200-bound contract's
 * UI seam (history comes from `storage.ts`, which clamps it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { HistoryPanel } from '../HistoryPanel';
import type { QueryHistoryEntry } from '../../lib/types';

vi.mock('../../lib/storage', () => ({
  loadHistory: vi.fn(),
  saveHistory: vi.fn(),
}));

import { loadHistory, saveHistory } from '../../lib/storage';

const loadHistoryMock = vi.mocked(loadHistory);
const saveHistoryMock = vi.mocked(saveHistory);

function entry(sql: string, at: string, status: 'ok' | 'error' = 'ok'): QueryHistoryEntry {
  return { sql, at, durationMs: 7, rowCount: 3, status };
}

const older = entry('select 1', '2026-01-01T00:00:00.000Z');
const newer = entry('select 2', '2026-01-02T00:00:00.000Z');

beforeEach(() => {
  loadHistoryMock.mockReset();
  saveHistoryMock.mockReset();
  saveHistoryMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('HistoryPanel — browse + re-run (R-4.1/R-4.2)', () => {
  it('lists entries newest-first and re-runs by loading SQL only', async () => {
    loadHistoryMock.mockResolvedValue([older, newer]);
    const onReRun = vi.fn();

    renderWithChakra(<HistoryPanel connectionId="c1" onReRun={onReRun} />);

    await waitFor(() => expect(screen.getAllByTestId('db-history-item')).toHaveLength(2));
    expect(loadHistoryMock).toHaveBeenCalledWith('c1');

    const items = screen.getAllByTestId('db-history-item');
    expect(within(items[0]).getByTestId('db-history-sql')).toHaveTextContent('select 2');
    expect(within(items[1]).getByTestId('db-history-sql')).toHaveTextContent('select 1');

    fireEvent.click(within(items[0]).getByTestId('db-history-rerun'));

    // Re-run loads the SQL into a tab; the panel never executes anything itself.
    expect(onReRun).toHaveBeenCalledTimes(1);
    expect(onReRun).toHaveBeenCalledWith('select 2');
  });

  it('surfaces the entry status', async () => {
    loadHistoryMock.mockResolvedValue([entry('bad', '2026-01-03T00:00:00.000Z', 'error')]);

    renderWithChakra(<HistoryPanel connectionId="c1" onReRun={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('db-history-item')).toBeDefined());
    expect(screen.getByTestId('db-history-status')).toHaveTextContent('error');
  });

  it('clears the connection history through storage', async () => {
    loadHistoryMock.mockResolvedValue([newer]);

    renderWithChakra(<HistoryPanel connectionId="c1" onReRun={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-history-item')).toBeDefined());

    fireEvent.click(screen.getByTestId('db-history-clear'));

    await waitFor(() => expect(saveHistoryMock).toHaveBeenCalledWith('c1', []));
    await waitFor(() => expect(screen.getByTestId('db-history-empty')).toBeDefined());
  });
});

describe('HistoryPanel — tolerant empty/corrupt handling (R-4.5)', () => {
  it('renders an empty list when the document is absent', async () => {
    loadHistoryMock.mockResolvedValue([]);
    renderWithChakra(<HistoryPanel connectionId="c1" onReRun={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-history-empty')).toBeDefined());
  });

  it('never fails the view when the load rejects', async () => {
    loadHistoryMock.mockRejectedValue(new Error('corrupt document'));
    renderWithChakra(<HistoryPanel connectionId="c1" onReRun={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-history-empty')).toBeDefined());
    expect(screen.queryAllByTestId('db-history-item')).toHaveLength(0);
  });

  it('shows the empty state without a connection and never loads', async () => {
    renderWithChakra(<HistoryPanel connectionId={null} onReRun={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-history-empty')).toBeDefined());
    expect(loadHistoryMock).not.toHaveBeenCalled();
  });
});
