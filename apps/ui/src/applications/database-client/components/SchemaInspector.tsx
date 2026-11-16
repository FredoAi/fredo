import React, { useEffect, useState } from 'react';
import { Box, Button, Flex, Spinner, Text } from '@chakra-ui/react';
import {
  LuBoxes,
  LuBraces,
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
 * SchemaInspector — definition view for the selected object (Spec #2950, ST-3).
 *
 * R-2.3: selecting a container object (table/view/schema/database) lazily loads
 * its children — columns+types, indexes and keys — and groups them into a
 * definition list. Leaf objects (column/index/key/function) carry their
 * definition in `SchemaNode.detail` (type / index DDL / constraint / function
 * signature) and render it directly with no extra fetch.
 *
 * R-2.4: a failed definition fetch renders an inline error with Retry.
 *
 * The component owns no IPC/credential logic — it consumes the frozen
 * `dbSchemaList` wrapper and the `SchemaNode` reported by `SchemaTree` (ST-7
 * wires the two together).
 */

const GROUP_ORDER: DbObjectKind[] = [
  'column',
  'index',
  'key',
  'table',
  'view',
  'function',
  'schema',
  'database',
];

const GROUP_LABELS: Record<DbObjectKind, string> = {
  database: 'Databases',
  schema: 'Schemas',
  table: 'Tables',
  view: 'Views',
  column: 'Columns',
  index: 'Indexes',
  key: 'Keys',
  function: 'Functions',
};

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

type InspectorStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface InspectorState {
  status: InspectorStatus;
  children: SchemaNode[];
  error?: string;
}

export interface SchemaInspectorProps {
  /** The active connection id, or `null` when disconnected. */
  connectionId: string | null;
  /** The node selected in the tree, or `null` when nothing is selected. */
  node: SchemaNode | null;
}

export const SchemaInspector: React.FC<SchemaInspectorProps> = ({ connectionId, node }) => {
  const [state, setState] = useState<InspectorState>({ status: 'idle', children: [] });
  const [reloadToken, setReloadToken] = useState(0);

  const nodeId = node?.id ?? null;
  const needsFetch = Boolean(node?.hasChildren);

  useEffect(() => {
    if (!connectionId || !nodeId || !needsFetch) {
      setState({ status: 'idle', children: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', children: [] });
    dbSchemaList({ connectionId, parentId: nodeId })
      .then((children) => {
        if (!cancelled) setState({ status: 'loaded', children });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ status: 'error', children: [], error: normalizeDbError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, nodeId, needsFetch, reloadToken]);

  if (!node) {
    return (
      <Box
        data-testid="db-schema-inspector"
        height="100%"
        minHeight="0"
        overflowY="auto"
        bg="bg.surface"
        p={4}
      >
        <Flex
          data-testid="db-schema-inspector-empty"
          direction="column"
          align="center"
          justify="center"
          gap={2}
          height="100%"
        >
          <Box color="fg.muted" display="flex" flexShrink={0}>
            <LuDatabase size={20} />
          </Box>
          <Text fontSize="xs" color="fg.muted" textAlign="center">
            Select an object to inspect
          </Text>
        </Flex>
      </Box>
    );
  }

  const groups = GROUP_ORDER.map((kind) => ({
    kind,
    items: state.children.filter((child) => child.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <Box
      data-testid="db-schema-inspector"
      data-inspected-id={node.id}
      height="100%"
      minHeight="0"
      overflowY="auto"
      bg="bg.surface"
      p={3}
    >
      <Flex align="center" gap={2} mb={3}>
        <Box color="accent.default" display="flex" alignItems="center" flexShrink={0}>
          {KIND_ICONS[node.kind]}
        </Box>
        <Text fontSize="sm" fontWeight="600" color="fg.default" wordBreak="break-word">
          {node.name}
        </Text>
        <Text fontSize="xs" color="fg.muted" flexShrink={0}>
          {KIND_LABELS[node.kind]}
        </Text>
      </Flex>

      {!node.hasChildren ? (
        <Box
          data-testid="db-schema-inspector-detail"
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="sm"
          p={2}
        >
          <Text fontSize="xs" fontFamily="mono" color="fg.default" wordBreak="break-word">
            {node.detail ?? 'No definition available.'}
          </Text>
        </Box>
      ) : state.status === 'loading' ? (
        <Flex data-testid="db-schema-inspector-loading" align="center" gap={2} py={2}>
          <Spinner size="xs" color="accent.default" />
          <Text fontSize="xs" color="fg.muted">
            Loading definition…
          </Text>
        </Flex>
      ) : state.status === 'error' ? (
        <Flex data-testid="db-schema-inspector-error" role="alert" align="center" gap={2} py={2}>
          <Box color="status.error" display="flex" alignItems="center" flexShrink={0}>
            <LuTriangleAlert size={12} />
          </Box>
          <Text fontSize="xs" color="status.error" flex="1" minWidth="0" wordBreak="break-word">
            {state.error}
          </Text>
          <Button
            data-testid="db-schema-inspector-retry"
            size="xs"
            variant="ghost"
            color="accent.default"
            flexShrink={0}
            onClick={() => setReloadToken((token) => token + 1)}
          >
            Retry
          </Button>
        </Flex>
      ) : state.status === 'loaded' && groups.length === 0 ? (
        <Text data-testid="db-schema-inspector-empty" fontSize="xs" color="fg.muted">
          No objects visible to this user.
        </Text>
      ) : (
        groups.map((group) => (
          <Box key={group.kind} mb={3}>
            <Text fontSize="xs" fontWeight="600" color="fg.muted" textTransform="uppercase" letterSpacing="wider" mb={1}>
              {GROUP_LABELS[group.kind]}
            </Text>
            {group.items.map((item) => (
              <Flex
                key={item.id}
                data-testid="db-schema-inspector-item"
                data-item-kind={item.kind}
                align="center"
                gap={2}
                py="2px"
              >
                <Box color="fg.muted" display="flex" alignItems="center" flexShrink={0}>
                  {KIND_ICONS[item.kind]}
                </Box>
                <Text fontSize="xs" color="fg.default" flexShrink={0}>
                  {item.name}
                </Text>
                {item.detail ? (
                  <Text fontSize="xs" color="fg.muted" flex="1" minWidth="0" wordBreak="break-word">
                    {item.detail}
                  </Text>
                ) : null}
              </Flex>
            ))}
          </Box>
        ))
      )}
    </Box>
  );
};
