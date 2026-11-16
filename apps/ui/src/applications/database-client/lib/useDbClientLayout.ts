/**
 * useDbClientLayout — the SQL Studio's single persisted layout source of truth
 * (Spec #3049, ST-1).
 *
 * Persistence goes through the app's persisted-preferences seam
 * (`usePersistedSetting` → `settingsService` → AppStore/SQLite KV) under
 * `DBCLIENT_LAYOUT_KEY` — never a React ref and never module-only state — so a
 * split survives a view remount AND a full app restart. `commit` clamps the new
 * value to the split's static `DBCLIENT_LAYOUT_LIMITS` and persists the whole
 * document (one write per drag-end / keyboard step).
 *
 * The container-aware tier-2 clamp (`effectiveMax`) is applied by the consuming
 * shell (ST-3), not here: storage only ever holds values inside tier-1.
 */

import { useCallback } from 'react';

import { serializeValue } from '../../settings';
import { usePersistedSetting } from '../../../shared/hooks/usePersistedSetting';
import { clampPref } from '../components/DatabaseClientSettings';
import {
  DBCLIENT_LAYOUT_KEY,
  DBCLIENT_LAYOUT_LIMITS,
  DEFAULT_DB_CLIENT_LAYOUT,
  parseDbClientLayout,
} from './storage';
import type { DbClientLayoutPrefs, DbClientSplitId } from './types';

export function useDbClientLayout(): {
  layout: DbClientLayoutPrefs;
  /** Clamp to the split's limits and persist (called once per drag-end / key step). */
  commit: (split: DbClientSplitId, px: number) => void;
} {
  const [layout, setLayout] = usePersistedSetting<DbClientLayoutPrefs>(
    DBCLIENT_LAYOUT_KEY,
    DEFAULT_DB_CLIENT_LAYOUT,
    serializeValue,
    parseDbClientLayout,
  );

  // `layout` changes only on commit, so `commit`'s identity is stable across
  // drags while still closing over the latest document (no stale merge).
  const commit = useCallback(
    (split: DbClientSplitId, px: number) => {
      const { min, max } = DBCLIENT_LAYOUT_LIMITS[split];
      const clamped = clampPref(px, min, max, DEFAULT_DB_CLIENT_LAYOUT[split]);
      setLayout({ ...layout, [split]: clamped });
    },
    [layout, setLayout],
  );

  return { layout, commit };
}
