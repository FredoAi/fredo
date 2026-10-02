/**
 * ST-1 storage tests (Spec #2950).
 *
 * Exercises the real `settingsService` against its localStorage fallback (the
 * jsdom test host has no Tauri invoke), so the tolerant-read contract (R-4.5),
 * the 200-entry history bound (R-4.1) and the secret-free persistence contract
 * are pinned end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adapterBridge } from '../../../../shared/utils/adapterBridge';
import {
  DBCLIENT_CONNECTIONS_KEY,
  DBCLIENT_HISTORY_KEY_PREFIX,
  DBCLIENT_HISTORY_MAX_ENTRIES,
  DBCLIENT_PREFS_KEY,
  DBCLIENT_SAVED_QUERIES_KEY_PREFIX,
  DEFAULT_DB_CLIENT_PREFS,
  appendHistory,
  clearConnectionData,
  historyKey,
  loadConnections,
  loadHistory,
  loadPrefs,
  loadSavedQueries,
  saveConnections,
  saveHistory,
  savePrefs,
  saveSavedQueries,
  savedQueriesKey,
} from '../storage';
import type { DbConnectionView, QueryHistoryEntry, SavedQuery } from '../types';

beforeEach(() => {
  localStorage.clear();
  // Force the localStorage fallback — no Tauri host in jsdom.
  adapterBridge.setInvoke(async () => {
    throw new Error('no tauri in test');
  });
});

afterEach(() => {
  localStorage.clear();
});

function makeView(): DbConnectionView {
  return {
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
}

function makeEntry(index: number): QueryHistoryEntry {
  return {
    sql: `select ${index}`,
    at: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    durationMs: index,
    rowCount: index,
    status: 'ok',
  };
}

describe('persistence key contract', () => {
  it('matches the frozen Fredo_dbclient_* names', () => {
    expect(DBCLIENT_CONNECTIONS_KEY).toBe('Fredo_dbclient_connections');
    expect(DBCLIENT_HISTORY_KEY_PREFIX).toBe('Fredo_dbclient_history_');
    expect(DBCLIENT_SAVED_QUERIES_KEY_PREFIX).toBe('Fredo_dbclient_saved_queries_');
    expect(DBCLIENT_PREFS_KEY).toBe('Fredo_dbclient_prefs');
  });

  it('builds per-connection keys', () => {
    expect(historyKey('abc')).toBe('Fredo_dbclient_history_abc');
    expect(savedQueriesKey('abc')).toBe('Fredo_dbclient_saved_queries_abc');
  });

  it('defaults prefs to row limit 100 / page size 100 / confirm true', () => {
    expect(DEFAULT_DB_CLIENT_PREFS).toEqual({
      defaultRowLimit: 100,
      pageSize: 100,
      confirmDestructive: true,
    });
  });
});

describe('connections', () => {
  it('returns [] when absent', async () => {
    await expect(loadConnections()).resolves.toEqual([]);
  });

  it('round-trips saved connections', async () => {
    const view = makeView();
    await saveConnections([view]);
    await expect(loadConnections()).resolves.toEqual([view]);
  });

  it('tolerates corrupt JSON (R-4.5)', async () => {
    localStorage.setItem(DBCLIENT_CONNECTIONS_KEY, '{not-json');
    await expect(loadConnections()).resolves.toEqual([]);
  });

  it('tolerates a non-array document (R-4.5)', async () => {
    localStorage.setItem(DBCLIENT_CONNECTIONS_KEY, '{"a":1}');
    await expect(loadConnections()).resolves.toEqual([]);
  });

  it('never persists a secret — the view carries no password field', async () => {
    await saveConnections([makeView()]);
    const raw = localStorage.getItem(DBCLIENT_CONNECTIONS_KEY) ?? '';
    expect(raw).toContain('hasPassword');
    expect(raw).not.toContain('"password"');
    expect(raw).not.toContain('secret');
  });
});

describe('preferences', () => {
  it('returns defaults when absent', async () => {
    await expect(loadPrefs()).resolves.toEqual(DEFAULT_DB_CLIENT_PREFS);
  });

  it('merges a partial stored document with defaults', async () => {
    localStorage.setItem(DBCLIENT_PREFS_KEY, JSON.stringify({ defaultRowLimit: 250 }));
    const prefs = await loadPrefs();
    expect(prefs.defaultRowLimit).toBe(250);
    expect(prefs.pageSize).toBe(DEFAULT_DB_CLIENT_PREFS.pageSize);
    expect(prefs.confirmDestructive).toBe(true);
  });

  it('ignores a non-numeric row limit', async () => {
    localStorage.setItem(DBCLIENT_PREFS_KEY, JSON.stringify({ defaultRowLimit: 'lots' }));
    await expect(loadPrefs()).resolves.toEqual(DEFAULT_DB_CLIENT_PREFS);
  });

  it('round-trips', async () => {
    const prefs = { defaultRowLimit: 50, pageSize: 25, confirmDestructive: false };
    await savePrefs(prefs);
    await expect(loadPrefs()).resolves.toEqual(prefs);
  });

  it('falls back to defaults on corrupt JSON', async () => {
    localStorage.setItem(DBCLIENT_PREFS_KEY, 'nope{');
    await expect(loadPrefs()).resolves.toEqual(DEFAULT_DB_CLIENT_PREFS);
  });
});

describe('history', () => {
  it('returns [] when absent and tolerates corrupt JSON', async () => {
    await expect(loadHistory('c1')).resolves.toEqual([]);
    localStorage.setItem(historyKey('c1'), 'broken');
    await expect(loadHistory('c1')).resolves.toEqual([]);
  });

  it('appendHistory prepends newest-first', async () => {
    await appendHistory('c1', makeEntry(1));
    await appendHistory('c1', makeEntry(2));
    const entries = await loadHistory('c1');
    expect(entries.map((e) => e.sql)).toEqual(['select 2', 'select 1']);
  });

  it('is per-connection', async () => {
    await appendHistory('c1', makeEntry(1));
    await expect(loadHistory('c2')).resolves.toEqual([]);
  });

  it('clamps to 200 entries, newest kept (R-4.1)', async () => {
    const many = Array.from({ length: 250 }, (_, i) => makeEntry(i));
    await saveHistory('c1', many);
    const entries = await loadHistory('c1');
    expect(entries).toHaveLength(DBCLIENT_HISTORY_MAX_ENTRIES);
    expect(entries[0]).toEqual(many[0]);

    // appendHistory also clamps, dropping the oldest.
    await appendHistory('c1', makeEntry(999));
    const after = await loadHistory('c1');
    expect(after).toHaveLength(DBCLIENT_HISTORY_MAX_ENTRIES);
    expect(after[0]).toEqual(makeEntry(999));
  });
});

describe('saved queries', () => {
  it('round-trips and is per-connection', async () => {
    const query: SavedQuery = {
      id: 'q1',
      name: 'all users',
      sql: 'select * from users',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await saveSavedQueries('c1', [query]);
    await expect(loadSavedQueries('c1')).resolves.toEqual([query]);
    await expect(loadSavedQueries('c2')).resolves.toEqual([]);
  });

  it('tolerates corrupt JSON', async () => {
    localStorage.setItem(savedQueriesKey('c1'), '[[[');
    await expect(loadSavedQueries('c1')).resolves.toEqual([]);
  });
});

describe('clearConnectionData (R-1.7)', () => {
  it('removes the per-connection history and saved-query documents', async () => {
    await appendHistory('c1', makeEntry(1));
    await saveSavedQueries('c1', [
      { id: 'q1', name: 'q', sql: 'select 1', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await clearConnectionData('c1');
    await expect(loadHistory('c1')).resolves.toEqual([]);
    await expect(loadSavedQueries('c1')).resolves.toEqual([]);
  });
});
