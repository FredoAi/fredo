import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Flex, HStack, Input, Switch, Text, VStack } from '@chakra-ui/react';
import {
  DEFAULT_DB_CLIENT_PREFS,
  loadPrefs,
  savePrefs,
} from '../lib/storage';
import { useSettingsSave } from '../../settings/SettingsSaveContext';
import type { DbClientPrefs } from '../lib/types';

/**
 * DatabaseClientSettings — the auto-discovered settings panel for
 * `DbClientPrefs` (Spec #2950, ST-7; R-1.4 settings surface).
 *
 * Rendered through `FredoFeatureClass.hasSettings`/`renderSettings()` and
 * discovered by `SettingsSurface` with NO central-list edit (G-220 — the
 * section is purely additive). Persistence goes through `storage.ts`
 * (`Fredo_dbclient_prefs`); the unified settings Save button is delegated to via
 * `useSettingsSave` — no direct save button here.
 *
 * Defaults: default row limit 100, page size 100, confirm destructive true.
 *
 * Token-first: semantic tokens only, no hex/rgba literal.
 */

/** Clamp a possibly-NaN/out-of-range integer into `[min, max]`. */
export function clampPref(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

export const DatabaseClientSettings: React.FC = () => {
  const [prefs, setPrefs] = useState<DbClientPrefs>(DEFAULT_DB_CLIENT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPrefs()
      .then((loadedPrefs) => {
        if (!cancelled) setPrefs(loadedPrefs);
      })
      .catch(() => {
        /* tolerant (R-4.5): defaults already in state */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = useCallback(async () => {
    const next: DbClientPrefs = {
      defaultRowLimit: clampPref(
        prefs.defaultRowLimit,
        1,
        5000,
        DEFAULT_DB_CLIENT_PREFS.defaultRowLimit,
      ),
      pageSize: clampPref(prefs.pageSize, 1, 5000, DEFAULT_DB_CLIENT_PREFS.pageSize),
      confirmDestructive: prefs.confirmDestructive,
    };
    setPrefs(next);
    await savePrefs(next);
    setStatus('Preferences saved');
  }, [prefs]);

  // Register with the unified settings Save button (no direct save button).
  // A ref keeps the registered fn pointing at the LATEST handler so a toggle
  // that re-renders the panel can never be persisted from a stale closure.
  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);
  const stableSave = useCallback(() => handleSaveRef.current(), []);
  useSettingsSave(loaded ? stableSave : null);

  return (
    <Flex
      data-testid="dbclient-settings"
      direction="column"
      gap={4}
      p={5}
      minHeight="100%"
    >
      <Text fontSize="sm" fontWeight="600" color="fg.default">
        PostgreSQL client preferences
      </Text>

      <VStack align="stretch" gap={4} maxWidth="420px">
        <Box>
          <Text fontSize="xs" fontWeight="600" color="fg.muted" mb={1}>
            Default row limit
          </Text>
          <Input
            data-testid="db-settings-default-row-limit"
            aria-label="Default row limit"
            type="number"
            min={1}
            max={5000}
            size="sm"
            bg="bg.surface"
            borderColor="border.default"
            color="fg.default"
            value={prefs.defaultRowLimit}
            onChange={(event) => {
              setPrefs((current) => ({ ...current, defaultRowLimit: Number(event.target.value) }));
              setStatus(null);
            }}
          />
          <Text fontSize="2xs" color="fg.muted" mt={1}>
            Rows fetched for the first page of a result set (1–5000).
          </Text>
        </Box>

        <Box>
          <Text fontSize="xs" fontWeight="600" color="fg.muted" mb={1}>
            Page size
          </Text>
          <Input
            data-testid="db-settings-page-size"
            aria-label="Page size"
            type="number"
            min={1}
            max={5000}
            size="sm"
            bg="bg.surface"
            borderColor="border.default"
            color="fg.default"
            value={prefs.pageSize}
            onChange={(event) => {
              setPrefs((current) => ({ ...current, pageSize: Number(event.target.value) }));
              setStatus(null);
            }}
          />
          <Text fontSize="2xs" color="fg.muted" mt={1}>
            Rows appended per "Load more" (1–5000).
          </Text>
        </Box>

        <HStack justify="space-between" align="center">
          <Box>
            <Text fontSize="xs" fontWeight="600" color="fg.muted">
              Confirm destructive statements
            </Text>
            <Text fontSize="2xs" color="fg.muted">
              Ask before running destructive or unknown SQL in read/write mode.
            </Text>
          </Box>
          <Switch.Root
            data-testid="db-settings-confirm-destructive"
            checked={prefs.confirmDestructive}
            size="md"
            colorPalette="accent"
            onCheckedChange={(details) => {
              setPrefs((current) => ({ ...current, confirmDestructive: details.checked }));
              setStatus(null);
            }}
          >
            <Switch.HiddenInput aria-label="Confirm destructive statements" />
            <Switch.Control data-testid="db-settings-confirm-destructive-control" />
          </Switch.Root>
        </HStack>

        {status ? (
          <Text data-testid="db-settings-status" fontSize="xs" color="status.success">
            {status}
          </Text>
        ) : null}
      </VStack>
    </Flex>
  );
};
