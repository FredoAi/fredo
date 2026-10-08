import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Flex, HStack, Input, Skeleton, Text } from '@chakra-ui/react';
import { loadSavedQueries, saveSavedQueries } from '../lib/storage';
import type { SavedQuery } from '../lib/types';

/**
 * SavedQueriesPanel — named saved queries per connection (Spec #2950, ST-6).
 *
 * R-4.3: saves a named query under
 * `Fredo_dbclient_saved_queries_<connectionId>` and loads a saved query's SQL
 * into a tab on open — it NEVER auto-executes.
 * R-4.5: an absent or corrupt document degrades to an empty list; a rejected
 * load is swallowed and the connection view stays usable.
 *
 * Persistence goes through `storage.ts` → `settingsService` only.
 */

export interface SavedQueriesPanelProps {
  connectionId: string | null;
  /** SQL currently in the active tab; enables "Save current query" (R-4.3). */
  currentSql?: string | null;
  /** Load a saved query's SQL into a query tab. Does NOT execute it (R-4.3). */
  onOpen: (sql: string) => void;
}

function newSavedQueryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const SavedQueriesPanel: React.FC<SavedQueriesPanelProps> = ({
  connectionId,
  currentSql = null,
  onOpen,
}) => {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!connectionId) {
      setQueries([]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    loadSavedQueries(connectionId)
      .then((list) => {
        if (!cancelled) setQueries(list);
      })
      .catch(() => {
        // R-4.5: a corrupt/absent document never fails the connection view.
        if (!cancelled) setQueries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const canSave =
    Boolean(connectionId) && Boolean(currentSql && currentSql.trim()) && name.trim().length > 0;

  const persist = useCallback(
    async (next: SavedQuery[]) => {
      setQueries(next);
      if (!connectionId) return;
      try {
        await saveSavedQueries(connectionId, next);
      } catch {
        /* tolerant — keep the in-memory list */
      }
    },
    [connectionId],
  );

  const handleSave = useCallback(async () => {
    if (!connectionId || !canSave || !currentSql) return;
    const query: SavedQuery = {
      id: newSavedQueryId(),
      name: name.trim(),
      sql: currentSql,
      createdAt: new Date().toISOString(),
    };
    setName('');
    await persist([...queries, query]);
  }, [connectionId, canSave, currentSql, name, queries, persist]);

  const handleDelete = useCallback(
    async (id: string) => {
      setPendingDeleteId(null);
      await persist(queries.filter((query) => query.id !== id));
    },
    [queries, persist],
  );

  const beginRename = useCallback((query: SavedQuery) => {
    setRenamingId(query.id);
    setRenameDraft(query.name);
  }, []);

  const commitRename = useCallback(
    async (id: string) => {
      const trimmed = renameDraft.trim();
      setRenamingId(null);
      if (!trimmed) return;
      await persist(
        queries.map((query) => (query.id === id ? { ...query, name: trimmed } : query)),
      );
    },
    [renameDraft, queries, persist],
  );

  return (
    <Flex
      data-testid="db-saved-queries"
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
        gap={2}
        borderBottomWidth="1px"
        borderColor="border.default"
        bg="bg.subtle"
      >
        <Text flex="1" fontSize="xs" fontWeight="600" color="fg.default">
          Saved queries
        </Text>
      </HStack>

      <HStack px={3} py={2} gap={2} flexShrink={0} borderBottomWidth="1px" borderColor="border.subtle">
        <Input
          data-testid="db-saved-name"
          size="xs"
          flex="1"
          placeholder="Name this query"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          data-testid="db-saved-save"
          size="xs"
          variant="solid"
          disabled={!canSave}
          onClick={handleSave}
        >
          Save
        </Button>
      </HStack>

      <Box flex="1" minHeight={0} overflowY="auto">
        {loading ? (
          <Flex data-testid="db-saved-loading" direction="column" gap={2} p={3}>
            <Skeleton height="16px" />
            <Skeleton height="16px" />
          </Flex>
        ) : queries.length === 0 ? (
          <Flex align="center" justify="center" height="100%" p={4}>
            <Text data-testid="db-saved-empty" fontSize="xs" color="fg.muted">
              No saved queries yet — save the current query
            </Text>
          </Flex>
        ) : (
          queries.map((query) => (
            <Box
              key={query.id}
              data-testid="db-saved-item"
              data-query-id={query.id}
              px={3}
              py={2}
              borderBottomWidth="1px"
              borderColor="border.subtle"
            >
              {renamingId === query.id ? (
                <Input
                  data-testid="db-saved-rename-input"
                  size="xs"
                  value={renameDraft}
                  autoFocus
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename(query.id);
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => void commitRename(query.id)}
                />
              ) : (
                <HStack gap={2} align="center">
                  <Text
                    data-testid="db-saved-name-label"
                    flex="1"
                    minWidth={0}
                    fontSize="xs"
                    color="fg.default"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    title={query.name}
                  >
                    {query.name}
                  </Text>
                  <Button
                    data-testid="db-saved-open"
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpen(query.sql)}
                  >
                    Open
                  </Button>
                  <Button
                    data-testid="db-saved-rename"
                    size="xs"
                    variant="ghost"
                    onClick={() => beginRename(query)}
                  >
                    Rename
                  </Button>
                  {pendingDeleteId === query.id ? (
                    <Button
                      data-testid="db-saved-delete-confirm"
                      size="xs"
                      variant="solid"
                      colorPalette="red"
                      onClick={() => void handleDelete(query.id)}
                    >
                      Confirm
                    </Button>
                  ) : (
                    <Button
                      data-testid="db-saved-delete"
                      size="xs"
                      variant="ghost"
                      onClick={() => setPendingDeleteId(query.id)}
                    >
                      Delete
                    </Button>
                  )}
                </HStack>
              )}
              <Text
                data-testid="db-saved-sql"
                mt={1}
                fontFamily="mono"
                fontSize="2xs"
                color="fg.muted"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                title={query.sql}
              >
                {query.sql}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Flex>
  );
};
