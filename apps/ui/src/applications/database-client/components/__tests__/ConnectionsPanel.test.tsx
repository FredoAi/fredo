/**
 * ConnectionsPanel tests (Spec #2950, ST-7; R-1.1/R-1.5/R-1.7).
 *
 * Pins the first-run empty state with the "Add connection" affordance (G-265),
 * the populated list (secret-free metadata + status), row selection, and the
 * confirmed delete flow.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ConnectionsPanel } from '../ConnectionsPanel';
import type { DbConnectionView } from '../../lib/types';

afterEach(() => cleanup());

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
  builtin: false,
};

const builtinView: DbConnectionView = {
  id: 'builtin-fredo',
  name: 'Fredo',
  engine: 'postgres',
  host: '127.0.0.1',
  port: 0,
  user: 'postgres',
  database: 'fredo',
  sslMode: 'disable',
  accessMode: 'readOnly',
  hasPassword: true,
  builtin: true,
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof ConnectionsPanel>> = {}) {
  const props = {
    connections: [] as DbConnectionView[],
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  renderWithChakra(<ConnectionsPanel {...props} />);
  return props;
}

describe('ConnectionsPanel — first-run empty state (R-1.1 / G-265)', () => {
  it('renders the empty state with an "Add connection" affordance before any connection exists', () => {
    const props = renderPanel({ connections: [] });
    expect(screen.getByTestId('db-connections-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('db-connection-new'));
    expect(props.onNew).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionsPanel — identity copy + full-width layout (Spec #3048, R-1.2 / R-5)', () => {
  it('positively names the app in the empty-state copy and carries no app-identity "PostgreSQL"', () => {
    renderPanel({ connections: [] });
    const empty = screen.getByTestId('db-connections-empty');
    expect(empty).toHaveTextContent(
      'No connections yet. Add a connection to get started with SQL Studio.',
    );
    expect(empty.textContent).toContain('SQL Studio');
    expect(empty.textContent).not.toMatch(/PostgreSQL/);
  });

  it('grows the panel to fill its flex column (flex: 1, min-width: 0)', () => {
    renderPanel({ connections: [] });
    const panel = screen.getByTestId('db-connections-panel');
    const style = getComputedStyle(panel);
    // The root must grow into the `display="flex"` wrapper so the header row
    // and each card span the full column width (no right dead space, R-5).
    expect(Number.parseFloat(style.flexGrow)).toBe(1);
    expect(Number.parseFloat(style.flexBasis)).toBe(0);
    expect(Number.parseFloat(style.minWidth)).toBe(0);
  });

  it('keeps the name + target as the ellipsis targets and wraps the target line', () => {
    renderPanel({ connections: [view] });
    const name = screen.getByTestId('db-connection-name');
    expect(getComputedStyle(name).textOverflow).toBe('ellipsis');
    expect(Number.parseFloat(getComputedStyle(name).minWidth)).toBe(0);
    expect(name).toHaveAttribute('title', 'local');
    // The DB name is the tail of the target line -> wrap so it stays visible.
    const target = screen.getByTestId('db-connection-target');
    expect(getComputedStyle(target).whiteSpace).toBe('normal');
    expect(target).toHaveAttribute('title', 'postgres@127.0.0.1:5432/postgres');
  });

  it('keeps the status dot, built-in badge, SSL label and actions exempt from clipping', () => {
    renderPanel({ connections: [builtinView] });
    for (const testid of ['db-connection-status-builtin-fredo', 'db-connection-builtin-badge', 'db-connection-ssl']) {
      const exempt = screen.getByTestId(testid);
      const style = getComputedStyle(exempt);
      expect(style.flexShrink).toBe('0');
      expect(style.textOverflow).not.toBe('ellipsis');
    }
    expect(screen.getByTestId('db-connection-edit-builtin-fredo')).toBeInTheDocument();
    expect(screen.getByTestId('db-connection-delete-builtin-fredo')).toBeInTheDocument();
  });
});

describe('ConnectionsPanel — loading and error states', () => {
  it('renders skeletons while loading', () => {
    renderPanel({ connections: [], loading: true });
    expect(screen.getByTestId('db-connections-loading')).toBeInTheDocument();
  });

  it('renders a non-vanishing error banner with Retry', () => {
    const onRetry = vi.fn();
    renderPanel({ connections: [], error: 'store unavailable', onRetry });
    expect(screen.getByTestId('db-connections-error')).toHaveTextContent('store unavailable');
    fireEvent.click(screen.getByTestId('db-connections-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionsPanel — populated list (R-1.5)', () => {
  it('renders the secret-free metadata and selects a row', () => {
    const props = renderPanel({ connections: [view], activeConnectionId: 'c1' });
    expect(screen.getByTestId('db-connection-row-c1')).toBeInTheDocument();
    expect(screen.getByTestId('db-connection-target')).toHaveTextContent(
      'postgres@127.0.0.1:5432/postgres',
    );
    expect(screen.getByTestId('db-connection-ssl')).toHaveTextContent('prefer');
    fireEvent.click(screen.getByTestId('db-connection-row-c1'));
    expect(props.onSelect).toHaveBeenCalledWith(view);
  });

  it('shows the connected status token for the connected connection', () => {
    renderPanel({ connections: [view], connectedConnectionId: 'c1' });
    expect(screen.getByTestId('db-connection-status-c1')).toHaveAttribute(
      'data-status',
      'connected',
    );
  });

  it('edits via the row action without selecting', () => {
    const props = renderPanel({ connections: [view] });
    fireEvent.click(screen.getByTestId('db-connection-edit-c1'));
    expect(props.onEdit).toHaveBeenCalledWith(view);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

describe('ConnectionsPanel — confirmed delete (R-1.7)', () => {
  it('requires an explicit confirm before deleting', () => {
    const props = renderPanel({ connections: [view] });
    fireEvent.click(screen.getByTestId('db-connection-delete-c1'));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('db-connection-delete-confirm'));
    expect(props.onDelete).toHaveBeenCalledWith(view);
  });
});

describe('ConnectionsPanel — built-in affordance (Spec #3029 ST-4)', () => {
  it('renders the built-in badge with an accessible name for a builtin row only', () => {
    renderPanel({ connections: [builtinView] });
    const badge = screen.getByTestId('db-connection-builtin-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Built-in');
    expect(badge).toHaveAttribute('aria-label', 'Built-in connection');
    expect(badge.tagName).toBe('SPAN');
    // Non-interactive: adds no tab stop.
    expect((badge as HTMLElement).tabIndex).toBe(-1);
  });

  it('omits the badge on an ordinary row', () => {
    renderPanel({ connections: [view] });
    expect(screen.queryByTestId('db-connection-builtin-badge')).not.toBeInTheDocument();
  });

  it('omits the port sentinel (`:0`) from the builtin target line', () => {
    renderPanel({ connections: [builtinView] });
    const target = screen.getByTestId('db-connection-target');
    expect(target).toHaveTextContent('postgres@127.0.0.1/fredo');
    expect(target.textContent).not.toContain(':0');
  });

  it('keeps the `:port` target line for an ordinary row', () => {
    renderPanel({ connections: [view] });
    expect(screen.getByTestId('db-connection-target')).toHaveTextContent(
      'postgres@127.0.0.1:5432/postgres',
    );
  });

  it('clicking the badge still selects the row (no stopPropagation)', () => {
    const props = renderPanel({ connections: [builtinView] });
    fireEvent.click(screen.getByTestId('db-connection-builtin-badge'));
    expect(props.onSelect).toHaveBeenCalledWith(builtinView);
  });

  it('labels the builtin delete confirm "Delete Fredo" with a warning line', () => {
    const props = renderPanel({ connections: [builtinView] });
    fireEvent.click(screen.getByTestId('db-connection-delete-builtin-fredo'));
    const confirm = screen.getByTestId('db-connection-delete-confirm');
    expect(confirm).toHaveTextContent('Delete Fredo');
    expect(
      screen.getByText("Fredo won't be recreated. You can add it again as a new connection."),
    ).toBeInTheDocument();
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(props.onDelete).toHaveBeenCalledWith(builtinView);
  });

  it('keeps the plain "Confirm" label and no warning for an ordinary row', () => {
    renderPanel({ connections: [view] });
    fireEvent.click(screen.getByTestId('db-connection-delete-c1'));
    expect(screen.getByTestId('db-connection-delete-confirm')).toHaveTextContent('Confirm');
    expect(screen.queryByText(/Fredo won't be recreated/)).not.toBeInTheDocument();
  });
});
