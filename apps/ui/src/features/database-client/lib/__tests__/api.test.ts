/**
 * ST-1 api wrapper tests (Spec #2950).
 *
 * Pins the nine command names and the single-`args`-struct wire convention, and
 * the hard-named error normalization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adapterBridge } from '../../../../shared/utils/adapterBridge';
import {
  dbConnect,
  dbConnectionDelete,
  dbConnectionList,
  dbConnectionSave,
  dbConnectionTest,
  dbDisconnect,
  dbQueryExecute,
  dbResultPage,
  dbSchemaList,
  normalizeDbError,
} from '../api';
import type {
  DbConnectArgs,
  DbConnectionDeleteArgs,
  DbConnectionSaveArgs,
  DbConnectionTestArgs,
  DbConnectionView,
  DbQueryArgs,
  DbResultPageArgs,
  DbSchemaListArgs,
} from '../types';

let invokeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invokeSpy = vi.spyOn(adapterBridge, 'invoke');
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
  hasPassword: false,
};

describe('normalizeDbError', () => {
  it('joins the backend string[] shape', () => {
    expect(normalizeDbError(['first', 'second'])).toBe('first; second');
  });

  it('reads an Error message', () => {
    expect(normalizeDbError(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else', () => {
    expect(normalizeDbError(42)).toBe('42');
  });
});

describe('command mapping', () => {
  it('dbConnectionList invokes db_connection_list with no args', async () => {
    invokeSpy.mockResolvedValue([view]);
    await expect(dbConnectionList()).resolves.toEqual([view]);
    expect(invokeSpy).toHaveBeenCalledWith('db_connection_list', undefined);
  });

  it('dbConnectionTest passes the args struct', async () => {
    const args: DbConnectionTestArgs = {
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'postgres',
      sslMode: 'prefer',
      password: 'pw',
    };
    invokeSpy.mockResolvedValue({ ok: true, serverVersion: '16', error: null });
    await dbConnectionTest(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_connection_test', { args });
  });

  it('dbConnectionSave passes the args struct', async () => {
    const args: DbConnectionSaveArgs = {
      name: 'local',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'postgres',
      sslMode: 'prefer',
      accessMode: 'readOnly',
    };
    invokeSpy.mockResolvedValue(view);
    await dbConnectionSave(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_connection_save', { args });
  });

  it('dbConnectionDelete passes the args struct', async () => {
    const args: DbConnectionDeleteArgs = { connectionId: 'c1' };
    invokeSpy.mockResolvedValue(null);
    await dbConnectionDelete(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_connection_delete', { args });
  });

  it('dbConnect / dbDisconnect pass the args struct', async () => {
    const args: DbConnectArgs = { connectionId: 'c1' };
    invokeSpy.mockResolvedValue({
      connectionId: 'c1',
      serverVersion: '16',
      accessMode: 'readOnly',
    });
    await dbConnect(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_connect', { args });

    invokeSpy.mockResolvedValue(null);
    await dbDisconnect(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_disconnect', { args });
  });

  it('dbSchemaList passes the args struct', async () => {
    const args: DbSchemaListArgs = { connectionId: 'c1', parentId: null };
    invokeSpy.mockResolvedValue([]);
    await dbSchemaList(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_schema_list', { args });
  });

  it('dbQueryExecute passes the args struct', async () => {
    const args: DbQueryArgs = {
      connectionId: 'c1',
      sql: 'select 1',
      mode: 'single',
      selection: null,
      confirmedStatementHashes: [],
    };
    invokeSpy.mockResolvedValue({ resultSets: [], confirmationRequired: null, error: null });
    await dbQueryExecute(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_query_execute', { args });
  });

  it('dbResultPage passes the args struct', async () => {
    const args: DbResultPageArgs = {
      connectionId: 'c1',
      resultSetId: 'rs1',
      offset: 100,
      limit: 100,
    };
    invokeSpy.mockResolvedValue({
      resultSetId: 'rs1',
      columns: [],
      rows: [],
      rowCountLoaded: 0,
      hasMore: false,
      truncated: false,
      durationMs: 1,
    });
    await dbResultPage(args);
    expect(invokeSpy).toHaveBeenCalledWith('db_result_page', { args });
  });
});

describe('error handling', () => {
  it('surfaces the backend string[] as a single Error message', async () => {
    invokeSpy.mockRejectedValue(['connection refused', 'host 127.0.0.1:1']);
    await expect(dbConnectionList()).rejects.toThrow(
      'connection refused; host 127.0.0.1:1',
    );
  });

  it('surfaces an Error rejection message', async () => {
    invokeSpy.mockRejectedValue(new Error('boom'));
    await expect(dbConnectionList()).rejects.toThrow('boom');
  });
});
