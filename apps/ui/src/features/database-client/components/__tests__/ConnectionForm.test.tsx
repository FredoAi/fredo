/**
 * ConnectionForm tests (Spec #2950, ST-7; R-1.1/R-1.2/R-1.3/R-1.4/R-1.6).
 *
 * Pins test-before-save: invalid input is rejected client-side with a
 * field-level message and no network call (R-1.2); a successful test enables
 * Save and shows the server version (R-1.3/R-1.4); a failed test keeps Save
 * disabled until a field changes (R-1.4); an edit with a blank password keeps
 * Save available without echoing the stored secret (R-1.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ConnectionForm, validateConnectionFields } from '../ConnectionForm';
import { dbConnectionSave, dbConnectionTest } from '../../lib/api';
import type { DbConnectionView } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  dbConnectionTest: vi.fn(),
  dbConnectionSave: vi.fn(),
  normalizeDbError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const testMock = vi.mocked(dbConnectionTest);
const saveMock = vi.mocked(dbConnectionSave);

const savedView: DbConnectionView = {
  id: '11111111-1111-4111-8111-111111111111',
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
  testMock.mockReset();
  saveMock.mockReset();
});

afterEach(() => cleanup());

describe('validateConnectionFields (R-1.2)', () => {
  it('rejects a missing name/host/user/database and an out-of-range port', () => {
    const errors = validateConnectionFields({
      name: '',
      host: '',
      port: '70000',
      user: '',
      database: '',
    });
    expect(errors.name).toBeDefined();
    expect(errors.host).toBeDefined();
    expect(errors.port).toBe('Port must be between 1 and 65535');
    expect(errors.user).toBeDefined();
    expect(errors.database).toBeDefined();
  });
});

describe('ConnectionForm — validation before any network call (R-1.2)', () => {
  it('shows field errors and never calls the test command for invalid input', () => {
    renderWithChakra(<ConnectionForm onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('db-conn-test'));
    expect(screen.getByTestId('db-conn-error-name')).toHaveTextContent('Name is required');
    expect(testMock).not.toHaveBeenCalled();
  });
});

describe('ConnectionForm — test-before-save (R-1.3/R-1.4)', () => {
  it('enables Save and shows the server version after a successful test', async () => {
    testMock.mockResolvedValue({
      ok: true,
      serverVersion: 'PostgreSQL 16.0',
      error: null,
    });
    renderWithChakra(<ConnectionForm onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('db-conn-name'), { target: { value: 'local' } });
    fireEvent.click(screen.getByTestId('db-conn-test'));

    await waitFor(() =>
      expect(screen.getByTestId('db-connection-test-result')).toHaveAttribute(
        'data-state',
        'success',
      ),
    );
    expect(screen.getByTestId('db-conn-test-success')).toHaveTextContent('PostgreSQL 16.0');
    expect(screen.getByTestId('db-conn-save')).toBeEnabled();
  });

  it('keeps Save disabled after a failed test and until a field changes (R-1.4)', async () => {
    testMock.mockResolvedValue({
      ok: false,
      serverVersion: null,
      error: {
        kind: 'auth',
        message: 'password authentication failed',
        line: null,
        column: null,
        position: null,
      },
    });
    renderWithChakra(<ConnectionForm onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('db-conn-name'), { target: { value: 'local' } });
    fireEvent.click(screen.getByTestId('db-conn-test'));

    await waitFor(() =>
      expect(screen.getByTestId('db-connection-test-result')).toHaveAttribute(
        'data-state',
        'failure',
      ),
    );
    expect(screen.getByTestId('db-conn-test-failure')).toHaveTextContent(
      'password authentication failed',
    );
    expect(screen.getByTestId('db-conn-save')).toBeDisabled();

    // A field change invalidates the failure, but Save stays disabled for a new
    // connection until a fresh successful test.
    fireEvent.change(screen.getByTestId('db-conn-host'), { target: { value: '10.0.0.5' } });
    expect(screen.getByTestId('db-conn-save')).toBeDisabled();
    expect(testMock).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionForm — save (R-1.5)', () => {
  it('saves after a successful test and reports the saved view', async () => {
    testMock.mockResolvedValue({ ok: true, serverVersion: 'v', error: null });
    saveMock.mockResolvedValue(savedView);
    const onSaved = vi.fn();
    renderWithChakra(<ConnectionForm onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('db-conn-name'), { target: { value: 'local' } });
    fireEvent.click(screen.getByTestId('db-conn-test'));
    await waitFor(() => expect(screen.getByTestId('db-conn-save')).toBeEnabled());

    fireEvent.click(screen.getByTestId('db-conn-save'));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        name: 'local',
        engine: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        database: 'postgres',
        accessMode: 'readOnly',
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(savedView);
  });
});

describe('ConnectionForm — edit with an unchanged secret (R-1.6)', () => {
  it('renders the password empty with an "unchanged" placeholder and enables Save', () => {
    renderWithChakra(<ConnectionForm initial={savedView} onSaved={vi.fn()} />);
    const password = screen.getByTestId('db-conn-password');
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('placeholder', 'unchanged');
    expect(screen.getByTestId('db-conn-save')).toBeEnabled();
    expect(testMock).not.toHaveBeenCalled();
  });
});
