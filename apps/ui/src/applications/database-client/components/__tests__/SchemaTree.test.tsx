/**
 * SchemaTree tests (Spec #2950, ST-3).
 *
 * Pins the lazy per-level browse (R-2.1/R-2.2), the inline node error + retry
 * (R-2.4), and the R-2.5 scroll/ellipsis contract: the tree scrolls vertically
 * within its pane and the node LABEL is the ONE ellipsizing child while the
 * chevron and object-kind icon render in full (G-273/G-274).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SchemaTree } from '../SchemaTree';
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

const database: SchemaNode = {
  kind: 'database',
  id: 'db',
  name: 'fredo',
  detail: '16.3',
  hasChildren: true,
};

const schemaPublic: SchemaNode = {
  kind: 'schema',
  id: 'db/public',
  name: 'public',
  detail: null,
  hasChildren: true,
};

const labels = (): (string | null)[] =>
  screen.getAllByTestId('db-schema-label').map((node) => node.textContent);

/** The toggle belonging to one specific node (the tree can render many). */
function toggleFor(nodeId: string): HTMLElement {
  const toggle = document.querySelector<HTMLElement>(
    `[data-node-id="${nodeId}"] [data-testid="db-schema-toggle"]`,
  );
  if (!toggle) throw new Error(`no toggle for node ${nodeId}`);
  return toggle;
}

beforeEach(() => {
  dbSchemaListMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SchemaTree — disconnected', () => {
  it('renders a disabled tree with a connect CTA and never fetches (R-2.1)', () => {
    renderWithChakra(<SchemaTree connectionId={null} />);

    expect(screen.getByTestId('db-schema-tree')).toBeDefined();
    expect(screen.getByTestId('db-schema-disconnected')).toBeDefined();
    expect(screen.getByText('Connect to browse the schema')).toBeDefined();
    expect(dbSchemaListMock).not.toHaveBeenCalled();
  });
});

describe('SchemaTree — lazy per-level browse (R-2.1/R-2.2)', () => {
  it('fetches only the root level on mount — no full-schema preload', async () => {
    dbSchemaListMock.mockResolvedValue([database]);

    renderWithChakra(<SchemaTree connectionId="c1" />);

    await waitFor(() => expect(labels()).toContain('fredo'));
    expect(dbSchemaListMock).toHaveBeenCalledTimes(1);
    expect(dbSchemaListMock).toHaveBeenCalledWith({ connectionId: 'c1', parentId: null });
  });

  it('fetches one level per expansion and shows an inline spinner while in flight (R-2.2)', async () => {
    let resolveChildren: (nodes: SchemaNode[]) => void = () => {};
    const childrenPromise = new Promise<SchemaNode[]>((resolve) => {
      resolveChildren = resolve;
    });
    dbSchemaListMock.mockResolvedValueOnce([database]);
    dbSchemaListMock.mockReturnValueOnce(childrenPromise);

    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('fredo'));

    fireEvent.click(screen.getByTestId('db-schema-toggle'));

    await waitFor(() => expect(screen.getByTestId('db-schema-loading')).toBeDefined());
    expect(dbSchemaListMock).toHaveBeenCalledTimes(2);
    expect(dbSchemaListMock).toHaveBeenLastCalledWith({ connectionId: 'c1', parentId: 'db' });

    await act(async () => {
      resolveChildren([schemaPublic]);
      await childrenPromise;
    });

    await waitFor(() => expect(labels()).toContain('public'));
    expect(screen.queryByTestId('db-schema-loading')).toBeNull();
  });

  it('keeps an already-loaded level without refetching when collapsed and re-expanded', async () => {
    dbSchemaListMock.mockResolvedValueOnce([database]);
    dbSchemaListMock.mockResolvedValueOnce([schemaPublic]);

    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('fredo'));

    fireEvent.click(screen.getByTestId('db-schema-toggle'));
    await waitFor(() => expect(labels()).toContain('public'));
    expect(dbSchemaListMock).toHaveBeenCalledTimes(2);

    // Collapse then re-expand: the cached level renders without a third fetch.
    fireEvent.click(toggleFor('db'));
    await waitFor(() => expect(labels()).not.toContain('public'));
    fireEvent.click(toggleFor('db'));
    await waitFor(() => expect(labels()).toContain('public'));
    expect(dbSchemaListMock).toHaveBeenCalledTimes(2);
  });

  it('shows an empty-level message when a level has no children (R-2.1)', async () => {
    dbSchemaListMock.mockResolvedValueOnce([database]);
    dbSchemaListMock.mockResolvedValueOnce([]);

    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('fredo'));

    fireEvent.click(screen.getByTestId('db-schema-toggle'));
    await waitFor(() => expect(screen.getByTestId('db-schema-empty')).toBeDefined());
  });
});

describe('SchemaTree — inline node errors (R-2.4)', () => {
  it('renders the error on the failing node, keeps the rest usable, and retries', async () => {
    dbSchemaListMock.mockResolvedValueOnce([database]);
    dbSchemaListMock.mockRejectedValueOnce(['catalog unavailable']);

    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('fredo'));

    fireEvent.click(screen.getByTestId('db-schema-toggle'));
    await waitFor(() => expect(screen.getByTestId('db-schema-error')).toBeDefined());
    expect(screen.getByTestId('db-schema-error').textContent).toContain('catalog unavailable');
    // The tree root remains rendered — a failed node never blanks the tree.
    expect(labels()).toContain('fredo');

    dbSchemaListMock.mockResolvedValueOnce([schemaPublic]);
    fireEvent.click(screen.getByTestId('db-schema-retry'));
    await waitFor(() => expect(labels()).toContain('public'));
  });

  it('shows a root-level error with retry when the initial fetch fails (R-2.4)', async () => {
    dbSchemaListMock.mockRejectedValueOnce(['connection lost']);

    renderWithChakra(<SchemaTree connectionId="c1" />);

    await waitFor(() => expect(screen.getByTestId('db-schema-error')).toBeDefined());
    expect(screen.getByTestId('db-schema-error').textContent).toContain('connection lost');

    dbSchemaListMock.mockResolvedValueOnce([database]);
    fireEvent.click(screen.getByTestId('db-schema-retry'));
    await waitFor(() => expect(labels()).toContain('fredo'));
  });
});

describe('SchemaTree — scroll + ellipsis contract (R-2.5 / G-273 / G-274)', () => {
  it('scrolls vertically in its pane and ellipsizes only the label', async () => {
    dbSchemaListMock.mockResolvedValue([database]);

    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('fredo'));

    const tree = screen.getByTestId('db-schema-tree');
    expect(getComputedStyle(tree).overflowY).toBe('auto');
    expect(getComputedStyle(tree).overflowX).toBe('hidden');

    const label = screen.getByTestId('db-schema-label');
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(label).overflow).toBe('hidden');
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap');
    // jsdom reports the unitless `0` for a zero min-width.
    expect(Number.parseFloat(getComputedStyle(label).minWidth)).toBe(0);

    // The chevron and object-kind icon are EXEMPT: never ellipsized, never
    // shrunk, and rendered in full (G-274).
    for (const testid of ['db-schema-toggle', 'db-schema-kind-icon']) {
      const exempt = screen.getByTestId(testid);
      const style = getComputedStyle(exempt);
      expect(style.textOverflow).not.toBe('ellipsis');
      expect(style.overflow).not.toBe('hidden');
      expect(style.flexShrink).toBe('0');
    }
    expect(screen.getByTestId('db-schema-kind-icon').querySelector('svg')).not.toBeNull();

    // Exactly ONE ellipsizing child in the whole tree — the label.
    const ellipsizing = Array.from(tree.querySelectorAll<HTMLElement>('*')).filter(
      (element) => getComputedStyle(element).textOverflow === 'ellipsis',
    );
    expect(ellipsizing).toHaveLength(1);
    expect(ellipsizing[0]).toBe(label);
  });
});

describe('SchemaTree — selection', () => {
  it('reports the selected node and marks it aria-selected', async () => {
    const onSelect = vi.fn();
    dbSchemaListMock.mockResolvedValue([database]);

    renderWithChakra(<SchemaTree connectionId="c1" onSelect={onSelect} />);
    await waitFor(() => expect(labels()).toContain('fredo'));

    fireEvent.click(screen.getByTestId('db-schema-node'));

    expect(onSelect).toHaveBeenCalledWith(database);
    expect(screen.getByTestId('db-schema-node').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('db-schema-node').getAttribute('role')).toBe('treeitem');
  });

  it('does not offer expansion for a leaf node', async () => {
    const column: SchemaNode = {
      kind: 'column',
      id: 'db/public/t/users/c/id',
      name: 'id',
      detail: 'integer',
      hasChildren: false,
    };
    dbSchemaListMock.mockResolvedValue([column]);

    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('id'));

    const node = screen.getByTestId('db-schema-node');
    expect(node.getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(screen.getByTestId('db-schema-toggle'));
    // A leaf toggle is inert — no extra fetch.
    expect(dbSchemaListMock).toHaveBeenCalledTimes(1);
  });
});
