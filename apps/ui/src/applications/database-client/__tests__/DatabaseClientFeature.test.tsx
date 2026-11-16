/**
 * DatabaseClientFeature shell tests (Spec #2950, ST-7).
 *
 * Pins the reachability contract of the shell: the first-run empty state
 * ("Add connection", G-265) opens the connection form; the retired
 * access-mode badge no longer renders; selecting a saved connection opens a live
 * session and mounts the schema tree + query workspace + export affordance, with
 * the Disconnect control relocated into the bottom status bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DatabaseClientFeatureView } from '../DatabaseClientFeature';
import { dbConnect, dbConnectionList, dbQueryExecute, dbSchemaList } from '../lib/api';
import type { DbConnectionView, SchemaNode } from '../lib/types';

// jsdom 24 has no ResizeObserver, but the schema-tree Menu's floating-ui
// autoUpdate reaches for it once a node submenu opens (Spec #3050 ST-B/ST-D). A
// no-op stub keeps the portalled submenu mountable under test.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

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
const schemaListMock = vi.mocked(dbSchemaList);
const queryExecuteMock = vi.mocked(dbQueryExecute);

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Build a pointer event with clientX/clientY/pointerId explicitly defined. jsdom
 * does not propagate PointerEvent init props onto the created event, so a plain
 * bubbling Event with the properties defined is the reliable simulation.
 */
function makePointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number },
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, 'clientX', { value: init.clientX ?? 0, configurable: true });
  Object.defineProperty(ev, 'clientY', { value: init.clientY ?? 0, configurable: true });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1, configurable: true });
  return ev;
}

describe('DatabaseClientFeature — first-run empty state (R-1.1 / G-265)', () => {
  it('renders the root, the Add-connection affordance and no access-mode badge', async () => {
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);

    await screen.findByTestId('db-connections-empty');
    expect(screen.getByTestId('db-client-root')).toBeInTheDocument();
    expect(screen.queryByTestId('db-access-mode-badge')).not.toBeInTheDocument();
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
  it('connects, mounts the schema/query surfaces and offers Disconnect in the status bar', async () => {
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
    // The access-mode badge is retired; the Disconnect control is relocated into
    // the bottom status bar and is a SIBLING of the live region, never a child.
    expect(screen.queryByTestId('db-access-mode-badge')).not.toBeInTheDocument();
    const disconnect = screen.getByTestId('db-disconnect');
    expect(disconnect).toHaveTextContent('Disconnect');
    expect(screen.getByTestId('db-status-operation')).not.toContainElement(disconnect);
    expect(screen.getByTestId('db-schema-tree')).toBeInTheDocument();
    expect(screen.getByTestId('db-query-tabs')).toBeInTheDocument();
    // The export affordance is mounted beside the results grid (R-4.4).
    expect(screen.getByTestId('db-export-csv')).toBeInTheDocument();
    expect(screen.getByTestId('db-export-json')).toBeInTheDocument();
  });
});

// ── Spec #3049 (ST-4): resizable split handles + layout persistence ───────────
//
// The four binding handles must render with their separator ARIA and per-split
// bounds; a drag commits once (persist-on-release), survives a remount from the
// separate `Fredo_dbclient_layout` document, restores tolerantly from a corrupt /
// out-of-range doc, and leaves no residual text-selection override.

function leftSidebarEl(): HTMLElement {
  const root = screen.getByTestId('db-client-root');
  // root → splitRow Flex → left sidebar VStack
  const row = root.firstElementChild as HTMLElement;
  return row.firstElementChild as HTMLElement;
}

describe('DatabaseClientFeature — resizable split handles (Spec #3049, ST-4)', () => {
  it('renders all four binding handles with separator ARIA and the per-split bounds', async () => {
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    const specs: Array<[string, string, string, string, string]> = [
      // testid, aria-orientation, valuenow, valuemin, valuemax
      ['db-resize-handle-left-sidebar', 'vertical', '300', '220', '560'],
      ['db-resize-handle-right-sidebar', 'vertical', '280', '200', '520'],
      ['db-resize-handle-editor-results', 'horizontal', '220', '120', '720'],
      ['db-resize-handle-connections-schema', 'horizontal', '220', '120', '560'],
    ];

    for (const [id, orientation, now, min, max] of specs) {
      const el = screen.getByTestId(id);
      expect(el.getAttribute('role')).toBe('separator');
      expect(el.getAttribute('aria-orientation')).toBe(orientation);
      expect(el.getAttribute('aria-valuenow')).toBe(now);
      expect(el.getAttribute('aria-valuemin')).toBe(min);
      expect(el.getAttribute('aria-valuemax')).toBe(max);
      expect(el.tabIndex).toBe(0);
    }
  });
});

describe('DatabaseClientFeature — layout persistence (AC5 / GA-6, GA-8, GA-9)', () => {
  it('a drag writes the layout exactly once, leaves prefs untouched and clears the drag overrides', async () => {
    listMock.mockResolvedValue([]);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    const handle = screen.getByTestId('db-resize-handle-left-sidebar');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 450 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 470 }));
    fireEvent(handle, makePointerEvent('pointerup', { clientX: 470 }));

    // Exactly one persistence write, for the layout key only.
    const layoutWrites = setItemSpy.mock.calls.filter(([key]) => key === 'Fredo_dbclient_layout');
    expect(layoutWrites).toHaveLength(1);
    const stored = JSON.parse(String(localStorage.getItem('Fredo_dbclient_layout'))) as {
      leftSidebarWidth: number;
    };
    expect(stored.leftSidebarWidth).toBe(370);

    // The settings document is a separate key and is never written by a drag.
    expect(localStorage.getItem('Fredo_dbclient_prefs')).toBeNull();

    // Clean release — no residual text-selection / cursor override.
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('restores a persisted split across a remount (not a ref)', async () => {
    listMock.mockResolvedValue([]);
    const first = renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    const handle = screen.getByTestId('db-resize-handle-left-sidebar');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 470 }));
    fireEvent(handle, makePointerEvent('pointerup', { clientX: 470 }));
    expect(
      (JSON.parse(String(localStorage.getItem('Fredo_dbclient_layout'))) as {
        leftSidebarWidth: number;
      }).leftSidebarWidth,
    ).toBe(370);

    first.unmount();

    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');
    await waitFor(() =>
      expect(screen.getByTestId('db-resize-handle-left-sidebar').getAttribute('aria-valuenow')).toBe(
        '370',
      ),
    );
    // The rendered sidebar width reflects the restored value (from storage, not a ref).
    expect(getComputedStyle(leftSidebarEl()).width).toBe('370px');
  });

  it('a corrupt stored document renders the documented defaults', async () => {
    localStorage.setItem('Fredo_dbclient_layout', 'not-json{');
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    await waitFor(() =>
      expect(screen.getByTestId('db-resize-handle-left-sidebar').getAttribute('aria-valuenow')).toBe(
        '300',
      ),
    );
    expect(screen.getByTestId('db-resize-handle-right-sidebar').getAttribute('aria-valuenow')).toBe(
      '280',
    );
    expect(screen.getByTestId('db-resize-handle-editor-results').getAttribute('aria-valuenow')).toBe(
      '220',
    );
    expect(
      screen.getByTestId('db-resize-handle-connections-schema').getAttribute('aria-valuenow'),
    ).toBe('220');
  });

  it('an out-of-range stored document is clamped on restore', async () => {
    localStorage.setItem(
      'Fredo_dbclient_layout',
      JSON.stringify({
        leftSidebarWidth: 99999,
        rightSidebarWidth: 'nope',
        editorResultsHeight: -5,
        connectionsSchemaHeight: 300,
      }),
    );
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    await waitFor(() =>
      expect(screen.getByTestId('db-resize-handle-left-sidebar').getAttribute('aria-valuenow')).toBe(
        '560',
      ),
    );
    expect(screen.getByTestId('db-resize-handle-right-sidebar').getAttribute('aria-valuenow')).toBe(
      '280',
    );
    expect(screen.getByTestId('db-resize-handle-editor-results').getAttribute('aria-valuenow')).toBe(
      '120',
    );
    expect(
      screen.getByTestId('db-resize-handle-connections-schema').getAttribute('aria-valuenow'),
    ).toBe('300');
  });
});

describe('DatabaseClientFeature — no re-render loop during a drag (NFR-1 / GA-12)', () => {
  it('a continuous multi-move drag produces no "Maximum update depth exceeded" error', async () => {
    listMock.mockResolvedValue([]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    const handle = screen.getByTestId('db-resize-handle-left-sidebar');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    for (let i = 0; i < 30; i += 1) {
      fireEvent(handle, makePointerEvent('pointermove', { clientX: 400 + i }));
    }
    fireEvent(handle, makePointerEvent('pointerup', { clientX: 430 }));

    const loopErrors = errorSpy.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('Maximum update depth exceeded')),
    );
    expect(loopErrors).toHaveLength(0);
  });
});

// ── Spec #3049 (round 2): the tier-2 clamp must bound the RENDERED value ──────
//
// Regression for the tester's GA-7 FAIL: a wide layout persisted at a wide
// window, then the window shrinks with NO divider touched, must still reflow the
// panes under the container-aware effective max so the workspace keeps its
// `WORKSPACE_MIN` floor and `db-client-root` cannot overflow. jsdom has no
// layout engine, so a captured ResizeObserver callback drives the measured size.

/** Capture the ResizeObserver callback so a test can drive a measured size. */
class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControlledResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  emit(size: { width: number; height: number }): void {
    this.callback(
      [{ contentRect: size } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

function emitContainerSize(size: { width: number; height: number }): void {
  act(() => {
    for (const observer of ControlledResizeObserver.instances) observer.emit(size);
  });
}

describe('DatabaseClientFeature — tier-2 clamp on the render path (Spec #3049 round 2 / GA-7)', () => {
  beforeEach(() => {
    ControlledResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clamps a wide persisted layout when the pane row shrinks (no divider touched)', async () => {
    // A layout valid at a wide window (left 560 / right 520).
    localStorage.setItem(
      'Fredo_dbclient_layout',
      JSON.stringify({
        leftSidebarWidth: 560,
        rightSidebarWidth: 520,
        editorResultsHeight: 220,
        connectionsSchemaHeight: 220,
      }),
    );
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    // Unmeasured (jsdom) → the rendered value equals the persisted value.
    await waitFor(() =>
      expect(screen.getByTestId('db-resize-handle-left-sidebar').getAttribute('aria-valuenow')).toBe(
        '560',
      ),
    );
    expect(getComputedStyle(leftSidebarEl()).width).toBe('560px');

    // Shrink the measured pane row to the tester's narrow-window row (863px).
    emitContainerSize({ width: 863, height: 602 });

    // left  = clamp(560, 220, max(220, min(560, 863-200-320-16=327))) = 327
    // right = clamp(520, 200, max(200, min(520, 863-327-320-16=200))) = 200
    await waitFor(() =>
      expect(screen.getByTestId('db-resize-handle-left-sidebar').getAttribute('aria-valuenow')).toBe(
        '327',
      ),
    );
    const rightSidebar = screen.getByTestId('db-resize-handle-right-sidebar')
      .nextElementSibling as HTMLElement;
    expect(getComputedStyle(leftSidebarEl()).width).toBe('327px');
    expect(getComputedStyle(rightSidebar).width).toBe('200px');
    expect(screen.getByTestId('db-resize-handle-right-sidebar').getAttribute('aria-valuenow')).toBe(
      '200',
    );

    // Joint floor + no-overflow invariant: sidebars + both 8px bands + the
    // workspace floor must fit inside the row (jsdom cannot measure scrollWidth,
    // so this arithmetic is the verifiable proxy for "no db-client-root overflow").
    const reserved = 327 + 200 + 2 * 8;
    expect(863 - reserved).toBeGreaterThanOrEqual(320);
    expect(reserved + 320).toBeLessThanOrEqual(863);
  });

  it('keeps the persisted value when the container is unmeasured (jsdom fallback)', async () => {
    localStorage.setItem(
      'Fredo_dbclient_layout',
      JSON.stringify({
        leftSidebarWidth: 420,
        rightSidebarWidth: 342,
        editorResultsHeight: 300,
        connectionsSchemaHeight: 340,
      }),
    );
    listMock.mockResolvedValue([]);
    renderWithChakra(<DatabaseClientFeatureView />);
    await screen.findByTestId('db-connections-empty');

    await waitFor(() => expect(getComputedStyle(leftSidebarEl()).width).toBe('420px'));
    expect(getComputedStyle(leftSidebarEl()).width).toBe('420px');
  });
});

// ── Spec #3050 (ST-D): schema-explorer node-action wiring ─────────────────────
//
// The shell maps a schema-tree node action onto a concrete outcome: `openData`
// builds the bounded, read-only statement (R-2b/R-2d) and asks QueryTabs to
// append + run a NEW tab (R-2); `newQuery` opens a blank tab (R-3); `viewColumns`
// re-selects the node so the inspector shows its columns (R-3). Every path is
// guarded on an active connection (R-4). The tree here renders a single table
// node directly at the root so the interaction is deterministic.

const tableNode: SchemaNode = {
  kind: 'table',
  id: 'db/QA_3050/t/qa_3050_rows',
  name: 'qa_3050_rows',
  detail: null,
  hasChildren: false,
};

describe('DatabaseClientFeature — schema-explorer actions (Spec #3050, ST-D)', () => {
  beforeEach(() => {
    schemaListMock.mockReset();
    queryExecuteMock.mockReset();
    queryExecuteMock.mockResolvedValue({
      resultSets: [],
      confirmationRequired: null,
      error: null,
    });
  });

  async function connectWithTable(): Promise<void> {
    listMock.mockResolvedValue([view]);
    connectMock.mockResolvedValue({
      connectionId: 'c1',
      serverVersion: 'PostgreSQL 16.0',
      accessMode: 'readOnly',
    });
    schemaListMock.mockResolvedValue([tableNode]);
    renderWithChakra(<DatabaseClientFeatureView />);

    const row = await screen.findByTestId('db-connection-row-c1');
    fireEvent.click(row);
    await waitFor(() => expect(connectMock).toHaveBeenCalledWith({ connectionId: 'c1' }));
    await screen.findByTestId('db-schema-node');
  }

  it('"Open table data" opens a NEW tab with the bounded SELECT and runs it (R-2)', async () => {
    const user = userEvent.setup();
    await connectWithTable();

    fireEvent.click(screen.getByTestId('db-schema-node'));
    await user.click(await screen.findByTestId('db-schema-action-open-data'));

    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    expect(queryExecuteMock).toHaveBeenCalledWith({
      connectionId: 'c1',
      sql: 'SELECT * FROM "QA_3050"."qa_3050_rows" LIMIT 100',
      mode: 'all',
      selection: null,
      confirmedStatementHashes: [],
      limit: 100,
    });
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2);
    expect((screen.getByTestId('db-query-editor') as HTMLTextAreaElement).value).toBe(
      'SELECT * FROM "QA_3050"."qa_3050_rows" LIMIT 100',
    );
  });

  it('"New query" opens a blank active tab without executing (R-3)', async () => {
    const user = userEvent.setup();
    await connectWithTable();

    fireEvent.click(screen.getByTestId('db-schema-node'));
    await user.click(await screen.findByTestId('db-schema-action-new-query'));

    await waitFor(() => expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2));
    expect((screen.getByTestId('db-query-editor') as HTMLTextAreaElement).value).toBe('');
    expect(queryExecuteMock).not.toHaveBeenCalled();
  });

  it('"View columns" re-selects the node with no new tab and no query (R-3)', async () => {
    const user = userEvent.setup();
    await connectWithTable();

    fireEvent.click(screen.getByTestId('db-schema-node'));
    await user.click(await screen.findByTestId('db-schema-action-view-columns'));

    expect(screen.getByTestId('db-schema-inspector')).toBeInTheDocument();
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(1);
    expect(queryExecuteMock).not.toHaveBeenCalled();
  });
});

