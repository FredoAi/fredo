import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Flex, HStack, Skeleton, Text } from '@chakra-ui/react';
import { loadHistory, saveHistory } from '../lib/storage';
import type { QueryHistoryEntry } from '../lib/types';

/**
 * HistoryPanel — bounded, per-connection query history (Spec #2950, ST-6).
 *
 * R-4.1: reads the connection's history document (already clamped to the 200
 * newest entries by `storage.ts`).
 * R-4.2: lists entries newest-first and offers a per-entry re-run that loads the
 * SQL into a tab — it NEVER auto-executes (avoiding accidental writes).
 * R-4.5: an absent or corrupt document degrades to an empty list; a rejected
 * load is swallowed and the connection view stays usable.
 *
 * Persistence goes through `storage.ts` → `settingsService` only.
 */

export interface HistoryPanelProps {
  connectionId: string | null;
  /** Load an entry's SQL into a query tab. Does NOT execute it (R-4.2). */
  onReRun: (sql: string) => void;
  /** Bump to reload after a query completes (R-4.1). */
  refreshKey?: number;
}

/** Newest-first ordering by ISO timestamp (R-4.2); stable for equal stamps. */
export function sortHistoryNewestFirst(entries: QueryHistoryEntry[]): QueryHistoryEntry[] {
  return [...entries].sort((a, b) => {
    const left = typeof a?.at === 'string' ? a.at : '';
    const right = typeof b?.at === 'string' ? b.at : '';
    return right.localeCompare(left);
  });
}

/** Human-readable timestamp; falls back to the raw value when unparseable. */
export function formatHistoryTimestamp(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  connectionId,
  onReRun,
  refreshKey = 0,
}) => {
  const [entries, setEntries] = useState<QueryHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!connectionId) {
      setEntries([]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    loadHistory(connectionId)
      .then((list) => {
        if (!cancelled) setEntries(sortHistoryNewestFirst(list));
      })
      .catch(() => {
        // R-4.5: a corrupt/absent document never fails the connection view.
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, refreshKey]);

  const handleClear = useCallback(async () => {
    if (!connectionId) return;
    try {
      await saveHistory(connectionId, []);
    } catch {
      /* tolerant — the in-memory list is still cleared */
    }
    setEntries([]);
  }, [connectionId]);

  return (
    <Flex
      data-testid="db-history-panel"
      direction="column"
      height="100%"
      minHeight={0}
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="sm"
      overflow="hidden"
    >
      <HStack
        px={3}
        py={2}
        flexShrink={0}
        borderBottomWidth="1px"
        borderColor="border.default"
        bg="bg.subtle"
      >
        <Text flex="1" fontSize="xs" fontWeight="600" color="fg.default">
          History
        </Text>
        {connectionId && entries.length > 0 ? (
          <Button data-testid="db-history-clear" size="xs" variant="ghost" onClick={handleClear}>
            Clear
          </Button>
        ) : null}
      </HStack>

      <Box flex="1" minHeight={0} overflowY="auto">
        {loading ? (
          <Flex data-testid="db-history-loading" direction="column" gap={2} p={3}>
            <Skeleton height="16px" />
            <Skeleton height="16px" />
            <Skeleton height="16px" />
          </Flex>
        ) : entries.length === 0 ? (
          <Flex align="center" justify="center" height="100%" p={4}>
            <Text data-testid="db-history-empty" fontSize="xs" color="fg.muted">
              No queries yet for this connection
            </Text>
          </Flex>
        ) : (
          entries.map((entry, index) => (
            <Box
              key={`${entry.at}-${index}`}
              data-testid="db-history-item"
              data-status={entry.status}
              px={3}
              py={2}
              borderBottomWidth="1px"
              borderColor="border.subtle"
            >
              <HStack gap={2} align="center">
                <Text
                  data-testid="db-history-status"
                  fontSize="2xs"
                  fontWeight="700"
                  textTransform="uppercase"
                  color={entry.status === 'ok' ? 'status.success' : 'status.error'}
                >
                  {entry.status}
                </Text>
                <Text fontSize="2xs" color="fg.muted">
                  {formatHistoryTimestamp(entry.at)}
                </Text>
                <Text fontSize="2xs" color="fg.muted">
                  {entry.durationMs} ms · {entry.rowCount} row{entry.rowCount === 1 ? '' : 's'}
                </Text>
                <Button
                  data-testid="db-history-rerun"
                  size="xs"
                  variant="ghost"
                  ml="auto"
                  onClick={() => onReRun(entry.sql)}
                >
                  Re-run
                </Button>
              </HStack>
              <Text
                data-testid="db-history-sql"
                mt={1}
                fontFamily="mono"
                fontSize="xs"
                color="fg.default"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                title={entry.sql}
              >
                {entry.sql}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Flex>
  );
};
