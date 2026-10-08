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
