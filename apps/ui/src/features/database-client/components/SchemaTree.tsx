import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Flex, Spinner, Text } from '@chakra-ui/react';
import {
  LuBoxes,
  LuBraces,
  LuChevronDown,
  LuChevronRight,
  LuColumns3,
  LuDatabase,
  LuEye,
  LuKeyRound,
  LuList,
  LuTable,
  LuTriangleAlert,
} from 'react-icons/lu';
import { dbSchemaList, normalizeDbError } from '../lib/api';
import type { DbObjectKind, SchemaNode } from '../lib/types';

/**
 * SchemaTree — lazy per-level schema browser (Spec #2950, ST-3).
 *
 * R-2.1/R-2.2: the tree is rooted at the connected database and fetches **only
 * the expanded level** via `db_schema_list` (never a full-schema preload). A
 * node shows an inline spinner while its children are in flight and stays
 * interactive for the rest of the tree.
 *
 * R-2.4: a failed fetch renders an inline error on the failing node with a
 * Retry action; the rest of the tree remains usable.
 *
 * R-2.5 (G-273/G-274): the tree scrolls vertically within its pane
 * (`overflow-y: auto`); the node LABEL is the ONE ellipsizing child, while the
 * expand/collapse chevron and the object-kind icon are `flex-shrink: 0` and
 * render in full.
 *
 * The component owns no IPC/credential logic — it consumes the frozen
 * `dbSchemaList` wrapper and reports selection upward via `onSelect` (ST-7
 * wires it to `SchemaInspector`).
 */

const ROOT_KEY = '\u0000root';

type LevelStatus = 'loading' | 'loaded' | 'error';

interface LevelState {
  status: LevelStatus;
  children: SchemaNode[];
  error?: string;
}

/** Object-kind icon — exempt from the label's ellipsis clamp (G-274). */
const KIND_ICONS: Record<DbObjectKind, React.ReactNode> = {
  database: <LuDatabase size={13} />,
  schema: <LuBoxes size={13} />,
  table: <LuTable size={13} />,
  view: <LuEye size={13} />,
  column: <LuColumns3 size={13} />,
  index: <LuList size={13} />,
  key: <LuKeyRound size={13} />,
  function: <LuBraces size={13} />,
};

const KIND_LABELS: Record<DbObjectKind, string> = {
  database: 'Database',
  schema: 'Schema',
  table: 'Table',
  view: 'View',
  column: 'Column',
  index: 'Index',
  key: 'Key',
  function: 'Function',
};

export interface SchemaTreeProps {
  /** The active connection id, or `null` when disconnected (disabled tree). */
  connectionId: string | null;
  /** Selection callback (the inspector consumes the selected node). */
  onSelect?: (node: SchemaNode | null) => void;
}

export const SchemaTree: React.FC<SchemaTreeProps> = ({ connectionId, onSelect }) => {
  const [levels, setLevels] = useState<Map<string, LevelState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const onSelectRef = useRef(onSelect);

  // Keep the callback in a ref so a parent re-render never re-triggers a fetch.
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const load = useCallback(
    async (parentId: string | null) => {
      if (!connectionId) return;
      const key = parentId ?? ROOT_KEY;
      setLevels((prev) => {
        const next = new Map(prev);
        next.set(key, { status: 'loading', children: prev.get(key)?.children ?? [] });
        return next;
      });
      try {
        const children = await dbSchemaList({ connectionId, parentId });
        setLevels((prev) => {
          const next = new Map(prev);
          next.set(key, { status: 'loaded', children });
          return next;
        });
      } catch (error) {
        setLevels((prev) => {
          const next = new Map(prev);
          next.set(key, {
            status: 'error',
            children: prev.get(key)?.children ?? [],
            error: normalizeDbError(error),
          });
          return next;
        });
      }
    },
    [connectionId],
  );

  // Re-root the whole tree whenever the connection changes.
  useEffect(() => {
    setLevels(new Map());
    setExpanded(new Set());
    setSelectedId(null);
    onSelectRef.current?.(null);
    if (connectionId) void load(null);
  }, [connectionId, load]);

  const toggle = useCallback(
    (node: SchemaNode) => {
      if (!node.hasChildren) return;
      const isExpanding = !expanded.has(node.id);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (isExpanding) next.add(node.id);
        else next.delete(node.id);
        return next;
      });
      // Lazy fetch only when this level has never been loaded (R-2.2).
      if (isExpanding && !levels.get(node.id)) void load(node.id);
    },
    [expanded, levels, load],
  );

  const select = useCallback((node: SchemaNode) => {
    setSelectedId(node.id);
    onSelectRef.current?.(node);
  }, []);

  const root = levels.get(ROOT_KEY);
  const rootNodes = root?.children ?? [];

  const renderNodes = (nodes: SchemaNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const state = levels.get(node.id);
      const isExpanded = expanded.has(node.id);
      const isSelected = selectedId === node.id;
      const indent = depth * 14 + 4;
      const childIndent = (depth + 1) * 14 + 24;
      return (
        <Box key={node.id} role="none">
          <Flex
            data-testid="db-schema-node"
            data-node-id={node.id}
            data-node-kind={node.kind}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={isSelected}
            aria-expanded={node.hasChildren ? isExpanded : undefined}
            align="center"
            gap={1}
            pl={`${indent}px`}
            pr={2}
            py="3px"
            cursor="pointer"
            bg={isSelected ? 'accent.subtle' : undefined}
            _hover={{ bg: isSelected ? 'accent.subtle' : 'bg.hover' }}
            onClick={() => select(node)}
          >
            <Box
              data-testid="db-schema-toggle"
              flexShrink={0}
              width="14px"
              display="flex"
              alignItems="center"
              justifyContent="center"
              color="fg.muted"
              onClick={(event) => {
                event.stopPropagation();
                toggle(node);
              }}
            >
              {node.hasChildren ? (
                isExpanded ? (
                  <LuChevronDown size={13} />
                ) : (
                  <LuChevronRight size={13} />
                )
              ) : null}
            </Box>
            <Box
              data-testid="db-schema-kind-icon"
              flexShrink={0}
              color="accent.default"
              display="flex"
              alignItems="center"
              title={KIND_LABELS[node.kind]}
            >
              {KIND_ICONS[node.kind]}
            </Box>
            <Text
              data-testid="db-schema-label"
              flex="1"
              minWidth="0"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              fontSize="xs"
              color="fg.default"
              title={node.name}
            >
              {node.name}
            </Text>
          </Flex>

          {node.hasChildren && isExpanded ? (
            <Box role="group">
              {state?.status === 'loading' ? (
                <Flex
                  data-testid="db-schema-loading"
                  align="center"
                  gap={2}
                  pl={`${childIndent}px`}
                  py="3px"
                >
                  <Spinner size="xs" color="accent.default" />
                  <Text fontSize="xs" color="fg.muted">
                    Loading…
                  </Text>
                </Flex>
              ) : null}
              {state?.status === 'error' ? (
                <Flex
                  data-testid="db-schema-error"
                  role="alert"
                  align="center"
                  gap={2}
                  pl={`${childIndent}px`}
                  pr={2}
                  py="3px"
                >
                  <Box color="status.error" display="flex" alignItems="center" flexShrink={0}>
                    <LuTriangleAlert size={12} />
                  </Box>
                  <Text fontSize="xs" color="status.error" flex="1" minWidth="0" wordBreak="break-word">
                    {state.error}
                  </Text>
                  <Button
                    data-testid="db-schema-retry"
                    size="xs"
                    variant="ghost"
                    color="accent.default"
                    flexShrink={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      void load(node.id);
                    }}
                  >
                    Retry
                  </Button>
                </Flex>
              ) : null}
              {state?.status === 'loaded' && state.children.length === 0 ? (
                <Text
                  data-testid="db-schema-empty"
                  fontSize="xs"
                  color="fg.muted"
                  pl={`${childIndent}px`}
                  py="3px"
                >
                  No objects visible to this user.
                </Text>
              ) : null}
              {state?.status === 'loaded' ? renderNodes(state.children, depth + 1) : null}
            </Box>
          ) : null}
        </Box>
      );
    });

  return (
    <Box
      data-testid="db-schema-tree"
      role="tree"
      aria-label="Database schema"
      height="100%"
      minHeight="0"
      overflowY="auto"
      overflowX="hidden"
      bg="bg.surface"
      borderRightWidth="1px"
      borderColor="border.default"
    >
      {connectionId === null ? (
        <Flex
          data-testid="db-schema-disconnected"
          direction="column"
          align="center"
          justify="center"
          gap={2}
          height="100%"
          p={4}
        >
          <Box color="fg.muted" display="flex" flexShrink={0}>
            <LuDatabase size={20} />
          </Box>
          <Text fontSize="xs" color="fg.muted" textAlign="center">
            Connect to browse the schema
          </Text>
        </Flex>
      ) : root?.status === 'loading' && rootNodes.length === 0 ? (
        <Flex data-testid="db-schema-loading" align="center" gap={2} p={3}>
          <Spinner size="xs" color="accent.default" />
          <Text fontSize="xs" color="fg.muted">
            Loading schema…
          </Text>
        </Flex>
      ) : root?.status === 'error' && rootNodes.length === 0 ? (
        <Flex data-testid="db-schema-error" role="alert" direction="column" gap={2} p={3}>
          <Text fontSize="xs" color="status.error">
            {root.error}
          </Text>
          <Button
            data-testid="db-schema-retry"
            size="xs"
            variant="outline"
            alignSelf="flex-start"
            onClick={() => void load(null)}
          >
            Retry
          </Button>
        </Flex>
      ) : (
        renderNodes(rootNodes, 0)
      )}
    </Box>
  );
};
