/**
 * DatabaseClientFeature shell tests (Spec #2950, ST-7).
 *
 * Pins the reachability contract of the shell: the first-run empty state
 * ("Add connection", G-265) opens the connection form; the always-visible
 * access-mode badge renders; selecting a saved connection opens a live session
 * and mounts the schema tree + query workspace + export affordance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DatabaseClientFeatureView } from '../DatabaseClientFeature';
import { dbConnect, dbConnectionList } from '../lib/api';
import type { DbConnectionView } from '../lib/types';

vi.mock('../lib/api', () => ({
  dbConnectionList: vi.fn(),
  dbConnectionTest: vi.fn(),
  dbConnectionSave: vi.fn(),
  dbConnectionDelete: vi.fn(),
  dbConnect: vi.fn(),
  dbDisconnect: vi.fn(),
  dbSchemaList: vi.fn(),
  dbQueryExecute: vi.fn(),
  dbResultPage: vi.fn(),
  normalizeDbError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const listMock = vi.mocked(dbConnectionList);
const connectMock = vi.mocked(dbConnect);

const view: DbConnectionView = {
  id: 'c1',
  name: 'local',
  engine: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'postgres',
  sslMode: 'prefer',
  accessMode: 'readOnly',
  hasPassword: true,
};

beforeEach(() => {
  listMock.mockReset();
  connectMock.mockReset();
  localStorage.clear();
});

afterEach(() => cleanup());

describe('DatabaseClientFeature — first-run empty state (R-1.1 / G-265)', () => {
  it('renders the root, the always-visible badge and the Add-connection affordance', async () => {
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);

    await screen.findByTestId('db-connections-empty');
    expect(screen.getByTestId('db-client-root')).toBeInTheDocument();
    expect(screen.getByTestId('db-access-mode-badge')).toHaveTextContent('Not connected');
    expect(screen.getByTestId('db-connection-new')).toHaveTextContent('Add connection');
  });

  it('opens the connection form from the empty-state affordance (R-1.1)', async () => {
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);

    await screen.findByTestId('db-connections-empty');
    fireEvent.click(screen.getByTestId('db-connection-new'));
    expect(screen.getByTestId('db-connection-form')).toBeInTheDocument();
  });
});

describe('DatabaseClientFeature — selecting a connection opens a session', () => {
  it('connects, shows the read-only badge and mounts the schema/query surfaces', async () => {
    listMock.mockResolvedValue([view]);
    connectMock.mockResolvedValue({
      connectionId: 'c1',
      serverVersion: 'PostgreSQL 16.0',
      accessMode: 'readOnly',
    });
    renderWithChakra(<DatabaseClientFeatureView />);

    const row = await screen.findByTestId('db-connection-row-c1');
    fireEvent.click(row);

    await waitFor(() => expect(connectMock).toHaveBeenCalledWith({ connectionId: 'c1' }));
    await waitFor(() =>
      expect(screen.getByTestId('db-connection-status-c1')).toHaveAttribute(
        'data-status',
        'connected',
      ),
    );
    expect(screen.getByTestId('db-access-mode-badge')).toHaveTextContent('Read-only');
    expect(screen.getByTestId('db-schema-tree')).toBeInTheDocument();
    expect(screen.getByTestId('db-query-tabs')).toBeInTheDocument();
    // The export affordance is mounted beside the results grid (R-4.4).
    expect(screen.getByTestId('db-export-csv')).toBeInTheDocument();
    expect(screen.getByTestId('db-export-json')).toBeInTheDocument();
  });
});
