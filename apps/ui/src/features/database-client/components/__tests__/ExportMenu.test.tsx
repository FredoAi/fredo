/**
 * ExportMenu tests (Spec #2950, ST-6; R-4.4, PO decision 6).
 *
 * Pins the CSV and JSON download affordances: both formats serialize the
 * currently loaded rows through a frontend-only Blob download, are disabled
 * until a result set exists, and never include connection metadata/credentials.
 */
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ExportMenu, exportFileName } from '../ExportMenu';
import type { DbColumn } from '../../lib/types';

const columns: DbColumn[] = [
  { name: 'id', typeName: 'int4' },
  { name: 'name', typeName: 'text' },
];

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // jsdom's Blob lacks `.text()` — use Node's Blob so the downloaded payload is readable.
  vi.stubGlobal('Blob', NodeBlob);
  createObjectURL = vi.fn(() => 'blob:mock');
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  clickSpy.mockRestore();
  vi.unstubAllGlobals();
  cleanup();
});

describe('ExportMenu — disabled until a result set exists', () => {
  it('disables both controls when there are no columns', () => {
    renderWithChakra(<ExportMenu columns={[]} rows={[]} />);
    expect(screen.getByTestId('db-export-csv')).toBeDisabled();
    expect(screen.getByTestId('db-export-json')).toBeDisabled();
  });

  it('enables both controls once a result set exists', () => {
    renderWithChakra(<ExportMenu columns={columns} rows={[[1, 'alice']]} />);
    expect(screen.getByTestId('db-export-csv')).toBeEnabled();
    expect(screen.getByTestId('db-export-json')).toBeEnabled();
  });
});

describe('ExportMenu — CSV download (R-4.4)', () => {
  it('downloads a CSV with a header row and the loaded rows', async () => {
    renderWithChakra(<ExportMenu columns={columns} rows={[[1, 'alice']]} />);

    fireEvent.click(screen.getByTestId('db-export-csv'));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe('id,name\r\n1,alice');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(screen.getByTestId('db-export-status')).toHaveTextContent('.csv');
  });
});

describe('ExportMenu — JSON download (PO decision 6)', () => {
  it('downloads JSON object keys and values matching the loaded rows', async () => {
    renderWithChakra(<ExportMenu columns={columns} rows={[[1, 'alice']]} />);

    fireEvent.click(screen.getByTestId('db-export-json'));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blob.text())).toEqual([{ id: 1, name: 'alice' }]);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('db-export-status')).toHaveTextContent('.json');
  });
});

describe('ExportMenu — secret-free (R-4.4)', () => {
  it('never emits connection metadata beyond the supplied columns', async () => {
    renderWithChakra(<ExportMenu columns={columns} rows={[[1, 'alice']]} />);

    fireEvent.click(screen.getByTestId('db-export-csv'));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = (await blob.text()).toLowerCase();
    expect(text).not.toContain('password');
    expect(text).not.toContain('dsn');
    expect(text).not.toContain('host=');
  });
});

describe('exportFileName', () => {
  it('derives a deterministic timestamp-only name (no connection identity)', () => {
    expect(exportFileName('csv', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'fredo-db-export-20260102-030405.csv',
    );
    expect(exportFileName('json', new Date(2026, 11, 31, 23, 59, 59))).toBe(
      'fredo-db-export-20261231-235959.json',
    );
  });
});
