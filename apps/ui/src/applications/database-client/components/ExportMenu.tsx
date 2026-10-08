import React, { useCallback, useState } from 'react';
import { Button, HStack, Text } from '@chakra-ui/react';
import { toCsv } from '../lib/csv';
import { toJson } from '../lib/json';
import type { DbColumn } from '../lib/types';

/**
 * ExportMenu — CSV / JSON export of the currently loaded result rows
 * (Spec #2950, ST-6; R-4.4, PO decision 6).
 *
 * The export is **frontend-only**: it serializes the already-loaded grid rows
 * (`columns` + `rows`) to a Blob and triggers an anchor download — there is no
 * backend file command. Because the only inputs are the visible grid contents,
 * an export can never include connection metadata, the DSN or a credential.
 *
 * Owned testids: `db-export-csv`, `db-export-json` (plus the additive
 * `db-export` / `db-export-status` sub-state hooks).
 */

export type ExportFormat = 'csv' | 'json';

/** Deterministic download name — timestamp only, never connection identity. */
export function exportFileName(format: ExportFormat, now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `fredo-db-export-${stamp}.${format}`;
}

/** Frontend-only Blob download helper (no backend file command). */
export function downloadTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface ExportMenuProps {
  /** Columns of the currently loaded result set. */
  columns: DbColumn[];
  /** Currently loaded rows (only what the grid holds — R-4.4). */
  rows: unknown[][];
  /** Explicitly disable the controls (e.g. while a query is running). */
  disabled?: boolean;
}

export const ExportMenu: React.FC<ExportMenuProps> = ({ columns, rows, disabled = false }) => {
  const [status, setStatus] = useState<string | null>(null);
  const canExport = !disabled && columns.length > 0;

  const runExport = useCallback(
    (format: ExportFormat) => {
      const content = format === 'csv' ? toCsv(columns, rows) : toJson(columns, rows);
      const filename = exportFileName(format);
      const mime =
        format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
      downloadTextFile(filename, content, mime);
      setStatus(`Exported ${filename}`);
    },
    [columns, rows],
  );

  return (
    <HStack data-testid="db-export" gap={2}>
      <Button
        data-testid="db-export-csv"
        size="xs"
        variant="outline"
        disabled={!canExport}
        onClick={() => runExport('csv')}
      >
        Export CSV
      </Button>
      <Button
        data-testid="db-export-json"
        size="xs"
        variant="outline"
        disabled={!canExport}
        onClick={() => runExport('json')}
      >
        Export JSON
      </Button>
      {status ? (
        <Text data-testid="db-export-status" fontSize="xs" color="fg.muted">
          {status}
        </Text>
      ) : null}
    </HStack>
  );
};
