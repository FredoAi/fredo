/**
 * usePersistedSetting
 *
 * Drop-in replacement for useState + manual save calls.
 * All persistence is routed through `settingsService` (features/settings)
 * which handles the Tauri SQLite write + localStorage fallback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsService, serializeValue } from '../../features/settings';

type Serialize<T> = (value: T) => string;
type Deserialize<T> = (raw: string) => T;

export function usePersistedSetting<T>(
  key: string,
  defaultValue: T,
  serialize: Serialize<T> = serializeValue,
  deserialize?: Deserialize<T>,
): [T, (value: T) => void] {
  const [value, setValueState] = useState<T>(defaultValue);
  const dirtyRef = useRef(false); // true once the user has set a value — don't overwrite with async load

  // ── Load on mount (async via settingsService) ──────────────────────
  // NOTE: no loadedRef guard here — React StrictMode double-fires effects and a
  // ref guard would survive the cleanup, preventing the second (real) mount from
  // loading the value. The [key] dep already prevents re-runs on normal re-renders.
  useEffect(() => {
    dirtyRef.current = false; // reset dirty on key change so new key loads correctly
    let cancelled = false;
    settingsService.get(key, defaultValue, deserialize).then((loaded) => {
      // Skip if user already changed the value while we were loading
      if (!cancelled && !dirtyRef.current) setValueState(loaded);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // ── Persist on change ──────────────────────────────────────────────
  const setValue = useCallback(
    (newValue: T) => {
      dirtyRef.current = true;
      setValueState(newValue);
      settingsService.set(key, serialize(newValue)).catch(() => { /* dev — ignore */ });
    },
    [key, serialize],
  );

  return [value, setValue];
}
