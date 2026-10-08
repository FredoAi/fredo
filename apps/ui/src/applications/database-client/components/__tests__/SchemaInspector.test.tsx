/**
 * SchemaInspector tests (Spec #2950, ST-3).
 *
 * Pins the definition view (R-2.3): a container selection lazily loads its
 * children and groups columns+types / indexes / keys; leaf objects render their
 * `detail` with no extra fetch. A failed fetch renders an inline error with
 * Retry (R-2.4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SchemaInspector } from '../SchemaInspector';
import type { SchemaNode } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  dbSchemaList: vi.fn(),
  normalizeDbError: (error: unknown) =>
    Array.isArray(error)
      ? error.map((item) => String(item)).join('; ')
      : error instanceof Error
        ? error.message
        : String(error),
}));

import { dbSchemaList } from '../../lib/api';

const dbSchemaListMock = vi.mocked(dbSchemaList);

const tableUsers: SchemaNode = {
  kind: 'table',
  id: 'db/public/t/users',
  name: 'users',
  detail: null,
  hasChildren: true,
};

const columnId: SchemaNode = {
  kind: 'column',
  id: 'db/public/t/users/c/id',
  name: 'id',
  detail: 'integer',
  hasChildren: false,
};

const columnEmail: SchemaNode = {
  kind: 'column',
  id: 'db/public/t/users/c/email',
  name: 'email',
  detail: 'text',
  hasChildren: false,
};

const indexPkey: SchemaNode = {
  kind: 'index',
  id: 'db/public/t/users/i/users_pkey',
  name: 'users_pkey',
  detail: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
  hasChildren: false,
};

const keyPkey: SchemaNode = {
  kind: 'key',
  id: 'db/public/t/users/k/users_pkey',
  name: 'users_pkey',
  detail: 'PRIMARY KEY (id)',
  hasChildren: false,
};

const functionNow: SchemaNode = {
  kind: 'function',
  id: 'db/public/f/now()',
  name: 'now',
  detail: 'now()',
  hasChildren: false,
};

beforeEach(() => {
  dbSchemaListMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SchemaInspector — empty / leaf (R-2.3)', () => {
  it('renders the empty state and never fetches without a selection', () => {
    renderWithChakra(<SchemaInspector connectionId="c1" node={null} />);

    expect(screen.getByTestId('db-schema-inspector')).toBeDefined();
    expect(screen.getByTestId('db-schema-inspector-empty')).toBeDefined();
    expect(dbSchemaListMock).not.toHaveBeenCalled();
  });

  it('renders a leaf function signature from detail without fetching (R-2.3)', () => {
    renderWithChakra(<SchemaInspector connectionId="c1" node={functionNow} />);

    expect(screen.getByTestId('db-schema-inspector-detail').textContent).toContain('now()');
    expect(dbSchemaListMock).not.toHaveBeenCalled();
  });

  it('renders a leaf column type from detail without fetching (R-2.3)', () => {
    renderWithChakra(<SchemaInspector connectionId="c1" node={columnId} />);

    expect(screen.getByTestId('db-schema-inspector-detail').textContent).toContain('integer');
    expect(dbSchemaListMock).not.toHaveBeenCalled();
  });
});

describe('SchemaInspector — container definition (R-2.3)', () => {
  it('lazily loads the selected object children and groups columns/indexes/keys', async () => {
    dbSchemaListMock.mockResolvedValue([columnId, columnEmail, indexPkey, keyPkey]);

    renderWithChakra(<SchemaInspector connectionId="c1" node={tableUsers} />);

    await waitFor(() =>
      expect(screen.getAllByTestId('db-schema-inspector-item')).toHaveLength(4),
    );
    expect(dbSchemaListMock).toHaveBeenCalledTimes(1);
    expect(dbSchemaListMock).toHaveBeenCalledWith({
      connectionId: 'c1',
      parentId: 'db/public/t/users',
    });

    // Grouped headings + the typed detail (columns+types, indexes, keys).
    expect(screen.getByText('Columns')).toBeDefined();
    expect(screen.getByText('Indexes')).toBeDefined();
    expect(screen.getByText('Keys')).toBeDefined();
    expect(screen.getByText('integer')).toBeDefined();
    expect(screen.getByText('text')).toBeDefined();
    expect(
      screen.getByText('CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)'),
    ).toBeDefined();
    expect(screen.getByText('PRIMARY KEY (id)')).toBeDefined();
  });

  it('shows a loading affordance while the definition is in flight', async () => {
    let resolveChildren: (nodes: SchemaNode[]) => void = () => {};
    const pending = new Promise<SchemaNode[]>((resolve) => {
      resolveChildren = resolve;
    });
    dbSchemaListMock.mockReturnValueOnce(pending);

    renderWithChakra(<SchemaInspector connectionId="c1" node={tableUsers} />);
    expect(screen.getByTestId('db-schema-inspector-loading')).toBeDefined();

    await act(async () => {
      resolveChildren([columnId]);
      await pending;
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('db-schema-inspector-item')).toHaveLength(1),
    );
  });

  it('shows an empty-definition message when the object has no children', async () => {
    dbSchemaListMock.mockResolvedValue([]);

    renderWithChakra(<SchemaInspector connectionId="c1" node={tableUsers} />);

    await waitFor(() =>
      expect(screen.getByTestId('db-schema-inspector-empty')).toBeDefined(),
    );
  });
});

describe('SchemaInspector — inline errors (R-2.4)', () => {
  it('renders an inline error and retries the definition fetch', async () => {
    dbSchemaListMock.mockRejectedValueOnce(['definition fetch failed']);

    renderWithChakra(<SchemaInspector connectionId="c1" node={tableUsers} />);

    await waitFor(() =>
      expect(screen.getByTestId('db-schema-inspector-error')).toBeDefined(),
    );
    expect(screen.getByTestId('db-schema-inspector-error').textContent).toContain(
      'definition fetch failed',
    );

    dbSchemaListMock.mockResolvedValueOnce([columnId]);
    fireEvent.click(screen.getByTestId('db-schema-inspector-retry'));
    await waitFor(() =>
      expect(screen.getAllByTestId('db-schema-inspector-item')).toHaveLength(1),
    );
  });
});
