import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Flex, Menu, Portal, Spinner, Text } from '@chakra-ui/react';
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
import { isDataNode } from '../lib/schemaRef';
import type { DbObjectKind, DbSchemaNodeAction, SchemaNode } from '../lib/types';

/**
 * SchemaTree — lazy per-level schema browser (Spec #2950, ST-3) + node actions
 * submenu (Spec #3050, ST-B).
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
 * R-1/R-3/R-5 (#3050): left-clicking a row selects the node (inspector updates)
 * AND opens the ONE shared, controlled actions submenu anchored to that row.
 * Applicability is omit-not-disable — "Open table data" + "View columns" only
 * for `table`/`view` nodes, "New query" for every kind; "Open table data" is
 * disabled while disconnected. The submenu content is portalled OUTSIDE
 * `db-schema-tree`, so the single-ellipsizing-child invariant is preserved.
 * A minimal roving-tabindex keyboard affordance opens the menu (Enter/Space),
 * closes it (Escape/outside/choose) and returns focus to the row.
 *
 * The component owns no IPC/credential logic — it consumes the frozen
 * `dbSchemaList` wrapper and reports selection upward via `onSelect` (ST-7
 * wires it to `SchemaInspector`) and node actions via `onNodeAction` (ST-D).
 */

const ROOT_KEY = '\u0000root';

type LevelStatus = 'loading' | 'loaded' | 'error';

interface LevelState {
  status: LevelStatus;
  children: SchemaNode[];
  error?: string;
}

/** The shared submenu's target node plus its anchor offset within the tree. */
interface MenuState {
  node: SchemaNode;
  top: number;
  left: number;
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

/** Styling shared by every action item (tokens only — no raw colour). */
const MENU_ITEM_STYLE = {
  fontSize: 'xs',
  color: 'fg.default',
  px: 3,
  py: '4px',
  borderRadius: 'xs',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  _highlighted: { bg: 'bg.hover' },
  _disabled: {
    layerStyle: 'none',
    opacity: 1,
    cursor: 'not-allowed',
    color: 'fg.subtle',
  },
} as const;

export interface SchemaTreeProps {
  /** The active connection id, or `null` when disconnected (disabled tree). */
  connectionId: string | null;
  /** Selection callback (the inspector consumes the selected node). */
  onSelect?: (node: SchemaNode | null) => void;
  /**
   * Report the currently loaded (flattened) nodes upward so the shell can pass
   * them to `QueryTabs` for schema-driven completion (R-3.9, ST-7 integration).
   */
  onNodesChange?: (nodes: SchemaNode[]) => void;
  /** Emit the chosen node action to the shell (ST-D handles its effects). */
  onNodeAction?: (action: DbSchemaNodeAction, node: SchemaNode) => void;
}

export const SchemaTree: React.FC<SchemaTreeProps> = ({
  connectionId,
  onSelect,
  onNodesChange,
  onNodeAction,
}) => {
  const [levels, setLevels] = useState<Map<string, LevelState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const onSelectRef = useRef(onSelect);
  const onNodesChangeRef = useRef(onNodesChange);
  const onNodeActionRef = useRef(onNodeAction);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastMenuNodeIdRef = useRef<string | null>(null);

  // Keep the callbacks in refs so a parent re-render never re-triggers a fetch.
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onNodesChangeRef.current = onNodesChange;
  }, [onNodesChange]);

  useEffect(() => {
    onNodeActionRef.current = onNodeAction;
  }, [onNodeAction]);

  // Flatten every loaded level into one completion source (R-3.9). Only fires
  // when a level actually loads, so it cannot loop with the parent's setState.
  useEffect(() => {
    const callback = onNodesChangeRef.current;
    if (!callback) return;
    const flat: SchemaNode[] = [];
    for (const state of levels.values()) {
      if (state.status === 'loaded' && Array.isArray(state.children)) {
        flat.push(...state.children);
      }
    }
    callback(flat);
  }, [levels]);

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
          // Tolerant read: a non-array response degrades to an empty level.
          next.set(key, {
            status: 'loaded',
            children: Array.isArray(children) ? children : [],
          });
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

  // Re-root the whole tree whenever the connection changes. The actions
  // submenu is deliberately NOT reset here: if the session drops while it is
  // open, it must stay mounted so "Open table data" can render `data-disabled`
  // (R-4 / AC4) rather than silently vanishing.
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

  /** Open the shared submenu for `node`, anchored to its row (R-1). */
  const openMenu = useCallback((node: SchemaNode, rowEl: HTMLElement) => {
    lastMenuNodeIdRef.current = node.id;
    const rowRect = rowEl.getBoundingClientRect();
    const treeRect = treeRef.current?.getBoundingClientRect();
    setMenu({
      node,
      top: rowRect.top - (treeRect?.top ?? 0),
      left: rowRect.left - (treeRect?.left ?? 0),
    });
  }, []);

  /** Return focus to the originating row after any close (R-1 / NFR). */
  const restoreRowFocus = useCallback(() => {
    const id = lastMenuNodeIdRef.current;
    if (id) rowRefs.current.get(id)?.focus();
  }, []);

  /** Close the shared submenu and return focus to its originating row. */
  const closeMenu = useCallback(() => {
    setMenu(null);
    // The 0x0 anchor trigger is not a meaningful focus target — put focus back
    // on the row the menu belongs to.
    requestAnimationFrame(restoreRowFocus);
  }, [restoreRowFocus]);

  const handleOpenChange = useCallback(
    (details: { open: boolean }) => {
      if (!details.open) closeMenu();
    },
    [closeMenu],
  );

  // Escape dismisses the submenu. Ark's own Escape handling is focus-scoped to
  // its content; this document listener guarantees dismissal (and row focus
  // return) even when the key event originates on the row.
  useEffect(() => {
    if (!menu) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menu, closeMenu]);

  const emitAction = useCallback((action: DbSchemaNodeAction, node: SchemaNode) => {
    onNodeActionRef.current?.(action, node);
  }, []);

  const handleRowClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, node: SchemaNode) => {
      select(node);
      openMenu(node, event.currentTarget);
    },
    [select, openMenu],
  );

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, node: SchemaNode) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        select(node);
        openMenu(node, event.currentTarget);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const rows = Array.from(
          treeRef.current?.querySelectorAll<HTMLElement>('[data-testid="db-schema-node"]') ?? [],
        );
        const index = rows.indexOf(event.currentTarget);
        rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    },
    [select, openMenu],
  );

  const root = levels.get(ROOT_KEY);
  const rootNodes = root?.children ?? [];
  // The roving tab stop: the selected row, or the first visible row when
  // nothing is selected yet. Determined during render, in visual order.
  let firstNodeId: string | null = null;

  const renderNodes = (nodes: SchemaNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (firstNodeId === null) firstNodeId = node.id;
      const state = levels.get(node.id);
      const isExpanded = expanded.has(node.id);
      const isSelected = selectedId === node.id;
      const isTabStop = isSelected || (selectedId === null && node.id === firstNodeId);
      const indent = depth * 14 + 4;
      const childIndent = (depth + 1) * 14 + 24;
      return (
        <Box key={node.id} role="none">
          <Flex
            ref={(element: HTMLDivElement | null) => {
              if (element) rowRefs.current.set(node.id, element);
              else rowRefs.current.delete(node.id);
            }}
            data-testid="db-schema-node"
            data-node-id={node.id}
            data-node-kind={node.kind}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={isSelected}
            aria-haspopup="menu"
            aria-expanded={node.hasChildren ? isExpanded : undefined}
            tabIndex={isTabStop ? 0 : -1}
            align="center"
            gap={1}
            pl={`${indent}px`}
            pr={2}
            py="3px"
            cursor="pointer"
            bg={isSelected ? 'accent.subtle' : undefined}
            _hover={{ bg: isSelected ? 'accent.subtle' : 'bg.hover' }}
            onClick={(event) => handleRowClick(event, node)}
            onKeyDown={(event) => handleRowKeyDown(event, node)}
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
    <Menu.Root open={menu !== null} onOpenChange={handleOpenChange} onExitComplete={restoreRowFocus}>
      <Box
        ref={treeRef}
        data-testid="db-schema-tree"
        role="tree"
        aria-label="Database schema"
        position="relative"
        height="100%"
        minHeight="0"
        overflowY="auto"
        overflowX="hidden"
        bg="bg.surface"
        borderRightWidth="1px"
        borderColor="border.default"
      >
        {/* The ONE shared menu's anchor — a 0x0 box placed at the target row. */}
        <Menu.Trigger asChild>
          <Box
            position="absolute"
            top={`${menu?.top ?? 0}px`}
            left={`${menu?.left ?? 0}px`}
            width="0"
            height="0"
            overflow="hidden"
            opacity={0}
            pointerEvents="none"
            tabIndex={-1}
          />
        </Menu.Trigger>

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

        {/* Portalled OUTSIDE `db-schema-tree` — never clipped, and the tree
            keeps exactly one ellipsizing child (G-273/G-274). */}
        <Portal>
          <Menu.Positioner>
            <Menu.Content
              data-testid="db-schema-actions-menu"
              data-node-id={menu?.node.id}
              aria-label={menu ? `${menu.node.name} actions` : 'Schema node actions'}
              minWidth="10rem"
              bg="bg.surface"
              borderColor="border.default"
              borderWidth="1px"
              borderRadius="sm"
              boxShadow="md"
              py={1}
            >
              {menu ? (
                <>
                  {isDataNode(menu.node.kind) ? (
                    <>
                      <Menu.Item
                        value="openData"
                        data-testid="db-schema-action-open-data"
                        disabled={connectionId === null}
                        onSelect={() => emitAction('openData', menu.node)}
                        {...MENU_ITEM_STYLE}
                      >
                        Open table data
                      </Menu.Item>
                      <Menu.Item
                        value="viewColumns"
                        data-testid="db-schema-action-view-columns"
                        onSelect={() => emitAction('viewColumns', menu.node)}
                        {...MENU_ITEM_STYLE}
                      >
                        View columns
                      </Menu.Item>
                    </>
                  ) : null}
                  <Menu.Item
                    value="newQuery"
                    data-testid="db-schema-action-new-query"
                    onSelect={() => emitAction('newQuery', menu.node)}
                    {...MENU_ITEM_STYLE}
                  >
                    New query
                  </Menu.Item>
                </>
              ) : null}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Box>
    </Menu.Root>
  );
};
