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
import userEvent from '@testing-library/user-event';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SchemaTree } from '../SchemaTree';
import type { SchemaNode } from '../../lib/types';

// jsdom 24 has no ResizeObserver, but the Chakra Menu's floating-ui autoUpdate
// reaches for it (Spec #3050 ST-B). A no-op stub keeps the portalled submenu
// mountable under test without changing the production component.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

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

describe('SchemaTree — node actions submenu (Spec #3050, ST-B)', () => {
  const usersTable: SchemaNode = {
    kind: 'table',
    id: 'db/public/t/users',
    name: 'users',
    detail: null,
    hasChildren: true,
  };
  const usersView: SchemaNode = {
    kind: 'view',
    id: 'db/public/v/v_users',
    name: 'v_users',
    detail: null,
    hasChildren: true,
  };
  const schemaNode: SchemaNode = {
    kind: 'schema',
    id: 'db/public',
    name: 'public',
    detail: null,
    hasChildren: true,
  };
  const functionNode: SchemaNode = {
    kind: 'function',
    id: 'db/public/f/now()',
    name: 'now',
    detail: 'now()',
    hasChildren: false,
  };

  const ITEM_ORDER = [
    'db-schema-action-open-data',
    'db-schema-action-view-columns',
    'db-schema-action-new-query',
  ];

  /** The rendered row for one node id (the tree can render many). */
  function nodeFor(nodeId: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      `[data-testid="db-schema-node"][data-node-id="${nodeId}"]`,
    );
    if (!element) throw new Error(`no rendered node ${nodeId}`);
    return element;
  }

  it('left-click selects the node AND opens the three-item submenu in order (R-1)', async () => {
    dbSchemaListMock.mockResolvedValue([usersTable]);
    const onSelect = vi.fn();
    renderWithChakra(<SchemaTree connectionId="c1" onSelect={onSelect} />);
    await waitFor(() => expect(labels()).toContain('users'));

    fireEvent.click(nodeFor('db/public/t/users'));

    expect(onSelect).toHaveBeenCalledWith(usersTable);
    const row = nodeFor('db/public/t/users');
    // Regression invariants — the row keeps its treeitem contract.
    expect(row.getAttribute('role')).toBe('treeitem');
    expect(row.getAttribute('data-node-kind')).toBe('table');
    expect(row.getAttribute('aria-selected')).toBe('true');
    // ... and gains the menu affordance.
    expect(row.getAttribute('aria-haspopup')).toBe('menu');

    const menuEl = await screen.findByTestId('db-schema-actions-menu');
    expect(menuEl.getAttribute('data-node-id')).toBe('db/public/t/users');
    const rendered = Array.from(
      menuEl.querySelectorAll<HTMLElement>('[data-testid^="db-schema-action-"]'),
    ).map((element) => element.getAttribute('data-testid'));
    expect(rendered).toEqual(ITEM_ORDER);
  });

  it('portals the submenu OUTSIDE the tree (G-273/G-274)', async () => {
    dbSchemaListMock.mockResolvedValue([usersTable]);
    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('users'));

    fireEvent.click(nodeFor('db/public/t/users'));

    const tree = screen.getByTestId('db-schema-tree');
    const menuEl = await screen.findByTestId('db-schema-actions-menu');
    expect(tree.contains(menuEl)).toBe(false);
    expect(document.body.contains(menuEl)).toBe(true);
  });

  it('offers data actions for a view too (R-5 positive control)', async () => {
    dbSchemaListMock.mockResolvedValue([usersView]);
    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('v_users'));

    fireEvent.click(nodeFor('db/public/v/v_users'));

    await screen.findByTestId('db-schema-actions-menu');
    expect(screen.getByTestId('db-schema-action-open-data')).toBeDefined();
    expect(screen.getByTestId('db-schema-action-view-columns')).toBeDefined();
    expect(screen.getByTestId('db-schema-action-new-query')).toBeDefined();
  });

  it('omits data actions for a non-table/view node — only "New query" remains (R-5)', async () => {
    dbSchemaListMock.mockResolvedValue([schemaNode, functionNode]);
    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('public'));

    fireEvent.click(nodeFor('db/public'));

    await screen.findByTestId('db-schema-actions-menu');
    expect(screen.getByTestId('db-schema-action-new-query')).toBeDefined();
    expect(screen.queryByTestId('db-schema-action-open-data')).toBeNull();
    expect(screen.queryByTestId('db-schema-action-view-columns')).toBeNull();
  });

  it('emits the chosen action and closes the menu (R-3)', async () => {
    const user = userEvent.setup();
    dbSchemaListMock.mockResolvedValue([usersTable]);
    const onNodeAction = vi.fn();
    renderWithChakra(<SchemaTree connectionId="c1" onNodeAction={onNodeAction} />);
    await waitFor(() => expect(labels()).toContain('users'));

    fireEvent.click(nodeFor('db/public/t/users'));
    const item = await screen.findByTestId('db-schema-action-new-query');
    await user.click(item);

    expect(onNodeAction).toHaveBeenCalledWith('newQuery', usersTable);
    await waitFor(() => expect(screen.queryByTestId('db-schema-actions-menu')).toBeNull());
  });

  it('opens by keyboard (Enter), closes on Escape, and returns focus to the row (NFR)', async () => {
    dbSchemaListMock.mockResolvedValue([usersTable]);
    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('users'));

    const row = nodeFor('db/public/t/users');
    row.focus();
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: 'Enter' });
    const menuEl = await screen.findByTestId('db-schema-actions-menu');
    menuEl.focus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('db-schema-actions-menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it('disables "Open table data" when the connection drops while the menu is open (R-4)', async () => {
    const user = userEvent.setup();
    dbSchemaListMock.mockResolvedValue([usersTable]);
    const onNodeAction = vi.fn();
    const { rerender } = renderWithChakra(
      <SchemaTree connectionId="c1" onNodeAction={onNodeAction} />,
    );
    await waitFor(() => expect(labels()).toContain('users'));

    fireEvent.click(nodeFor('db/public/t/users'));
    const item = await screen.findByTestId('db-schema-action-open-data');
    expect(item.hasAttribute('data-disabled')).toBe(false);

    rerender(<SchemaTree connectionId={null} onNodeAction={onNodeAction} />);

    const disabledItem = screen.getByTestId('db-schema-action-open-data');
    expect(disabledItem.hasAttribute('data-disabled')).toBe(true);
    await user.click(disabledItem);
    expect(onNodeAction).not.toHaveBeenCalled();
  });

  it('keeps the toggle from opening the menu (R-1 regression / F-46)', async () => {
    dbSchemaListMock.mockResolvedValueOnce([database]);
    dbSchemaListMock.mockResolvedValueOnce([usersTable]);
    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('fredo'));

    fireEvent.click(screen.getByTestId('db-schema-toggle'));
    await waitFor(() => expect(labels()).toContain('users'));
    expect(screen.queryByTestId('db-schema-actions-menu')).toBeNull();
  });

  it('keeps exactly one roving tab stop across the rendered rows (NFR)', async () => {
    dbSchemaListMock.mockResolvedValue([schemaNode, functionNode]);
    renderWithChakra(<SchemaTree connectionId="c1" />);
    await waitFor(() => expect(labels()).toContain('public'));

    const stops = screen
      .getAllByTestId('db-schema-node')
      .filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('data-node-id')).toBe('db/public');
  });
});
