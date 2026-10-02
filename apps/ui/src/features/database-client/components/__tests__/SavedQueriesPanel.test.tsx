/**
 * SavedQueriesPanel tests (Spec #2950, ST-6; R-4.3/R-4.5).
 *
 * Pins named-query persistence through `storage.ts`, open-loads-SQL (never
 * executes), delete/rename persistence and the tolerant empty state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SavedQueriesPanel } from '../SavedQueriesPanel';
import type { SavedQuery } from '../../lib/types';

vi.mock('../../lib/storage', () => ({
  loadSavedQueries: vi.fn(),
  saveSavedQueries: vi.fn(),
}));

import { loadSavedQueries, saveSavedQueries } from '../../lib/storage';

const loadSavedQueriesMock = vi.mocked(loadSavedQueries);
const saveSavedQueriesMock = vi.mocked(saveSavedQueries);

const saved: SavedQuery = {
  id: 'q1',
  name: 'all users',
  sql: 'select * from users',
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  loadSavedQueriesMock.mockReset();
  saveSavedQueriesMock.mockReset();
  saveSavedQueriesMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('SavedQueriesPanel — save + open (R-4.3)', () => {
  it('persists a named query and lists it', async () => {
    loadSavedQueriesMock.mockResolvedValue([]);
    renderWithChakra(
      <SavedQueriesPanel connectionId="c1" currentSql="select * from users" onOpen={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('db-saved-empty')).toBeDefined());

    fireEvent.change(screen.getByTestId('db-saved-name'), { target: { value: 'all users' } });
    fireEvent.click(screen.getByTestId('db-saved-save'));

    await waitFor(() => expect(saveSavedQueriesMock).toHaveBeenCalledTimes(1));
    const [connectionId, persisted] = saveSavedQueriesMock.mock.calls[0];
    expect(connectionId).toBe('c1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ name: 'all users', sql: 'select * from users' });
    expect(persisted[0].id).toBeTruthy();
    expect(persisted[0].createdAt).toBeTruthy();

    await waitFor(() => expect(screen.getByTestId('db-saved-item')).toBeDefined());
    expect(screen.getByTestId('db-saved-name-label')).toHaveTextContent('all users');
  });

  it('disables Save without a name or current SQL', async () => {
    loadSavedQueriesMock.mockResolvedValue([]);
    renderWithChakra(<SavedQueriesPanel connectionId="c1" currentSql="" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-saved-empty')).toBeDefined());

    expect(screen.getByTestId('db-saved-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('db-saved-name'), { target: { value: 'x' } });
    expect(screen.getByTestId('db-saved-save')).toBeDisabled();
  });

  it('loads a saved query into a tab on open (never executes)', async () => {
    loadSavedQueriesMock.mockResolvedValue([saved]);
    const onOpen = vi.fn();
    renderWithChakra(<SavedQueriesPanel connectionId="c1" currentSql="select 1" onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByTestId('db-saved-item')).toBeDefined());
    fireEvent.click(screen.getByTestId('db-saved-open'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('select * from users');
  });
});

describe('SavedQueriesPanel — delete + rename persistence', () => {
  it('confirms then deletes a saved query through storage', async () => {
    loadSavedQueriesMock.mockResolvedValue([saved]);
    renderWithChakra(<SavedQueriesPanel connectionId="c1" currentSql="select 1" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-saved-item')).toBeDefined());

    fireEvent.click(screen.getByTestId('db-saved-delete'));
    expect(screen.getByTestId('db-saved-delete-confirm')).toBeDefined();
    fireEvent.click(screen.getByTestId('db-saved-delete-confirm'));

    await waitFor(() => expect(saveSavedQueriesMock).toHaveBeenCalledWith('c1', []));
    await waitFor(() => expect(screen.getByTestId('db-saved-empty')).toBeDefined());
  });

  it('renames a saved query through storage', async () => {
    loadSavedQueriesMock.mockResolvedValue([saved]);
    renderWithChakra(<SavedQueriesPanel connectionId="c1" currentSql="select 1" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-saved-item')).toBeDefined());

    fireEvent.click(screen.getByTestId('db-saved-rename'));
    const input = screen.getByTestId('db-saved-rename-input');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(saveSavedQueriesMock).toHaveBeenCalledWith('c1', [
        expect.objectContaining({ id: 'q1', name: 'renamed', sql: 'select * from users' }),
      ]),
    );
    expect(within(screen.getByTestId('db-saved-item')).getByTestId('db-saved-name-label')).toHaveTextContent(
      'renamed',
    );
  });
});

describe('SavedQueriesPanel — tolerant empty/corrupt handling (R-4.5)', () => {
  it('renders an empty list when the document is absent', async () => {
    loadSavedQueriesMock.mockResolvedValue([]);
    renderWithChakra(<SavedQueriesPanel connectionId="c1" currentSql="select 1" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-saved-empty')).toBeDefined());
  });

  it('never fails the view when the load rejects', async () => {
    loadSavedQueriesMock.mockRejectedValue(new Error('corrupt document'));
    renderWithChakra(<SavedQueriesPanel connectionId="c1" currentSql="select 1" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-saved-empty')).toBeDefined());
    expect(screen.queryAllByTestId('db-saved-item')).toHaveLength(0);
  });

  it('shows the empty state without a connection and never loads', async () => {
    renderWithChakra(<SavedQueriesPanel connectionId={null} currentSql="select 1" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('db-saved-empty')).toBeDefined());
    expect(loadSavedQueriesMock).not.toHaveBeenCalled();
  });
});
