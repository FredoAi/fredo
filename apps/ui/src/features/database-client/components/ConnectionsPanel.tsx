import React, { useState } from 'react';
import { Box, Button, Flex, HStack, Skeleton, Text } from '@chakra-ui/react';
import { LuPlus, LuTriangleAlert } from 'react-icons/lu';
import type { DbConnectionView } from '../lib/types';

/**
 * ConnectionsPanel — the saved-connections list with first-run empty state
 * (Spec #2950, ST-7; R-1.1/R-1.5/R-1.7).
 *
 * R-1.1 / G-265: when no connection exists the empty state with an
 * "Add connection" affordance (`db-connection-new`) is rendered BEFORE any
 * connection is saved — the trigger is reachable on first run.
 * R-1.5: each row shows the secret-free connection metadata (name,
 * `user@host:port/db`, SSL mode) and a status dot.
 * R-1.7: delete is confirmed inline before the shell removes the connection.
 *
 * Token-first: semantic tokens only, no hex/rgba literal.
 */

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ConnectionsPanelProps {
  connections: DbConnectionView[];
  loading?: boolean;
  error?: string | null;
  /** The selected connection id, or `null`. */
  activeConnectionId?: string | null;
  /** The successfully-connected connection id, or `null`. */
  connectedConnectionId?: string | null;
  /** Per-connection status override (connect failure). */
  statuses?: Record<string, ConnectionStatus>;
  onSelect: (view: DbConnectionView) => void;
  onNew: () => void;
  onEdit: (view: DbConnectionView) => void;
  onDelete: (view: DbConnectionView) => void;
  onRetry?: () => void;
}

const STATUS_TOKEN: Record<ConnectionStatus, string> = {
  idle: 'fg.muted',
  connecting: 'status.info',
  connected: 'status.success',
  error: 'status.error',
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error',
};

export const ConnectionsPanel: React.FC<ConnectionsPanelProps> = ({
  connections,
  loading = false,
  error = null,
  activeConnectionId = null,
  connectedConnectionId = null,
  statuses = {},
  onSelect,
  onNew,
  onEdit,
  onDelete,
  onRetry,
}) => {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const statusFor = (view: DbConnectionView): ConnectionStatus =>
    statuses[view.id] ?? (view.id === connectedConnectionId ? 'connected' : 'idle');

  return (
    <Flex
      data-testid="db-connections-panel"
      direction="column"
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
          Connections
        </Text>
        {connections.length > 0 ? (
          <Button data-testid="db-connection-new" size="xs" variant="outline" onClick={onNew}>
            <LuPlus size={12} />
            New
          </Button>
        ) : null}
      </HStack>

      {error ? (
        <Flex
          data-testid="db-connections-error"
          role="alert"
          align="center"
          gap={2}
          px={3}
          py={2}
          flexShrink={0}
          bg="bg.subtle"
          borderBottomWidth="1px"
          borderColor="status.error"
        >
          <Box color="status.error" display="flex" flexShrink={0} aria-hidden="true">
            <LuTriangleAlert size={12} />
          </Box>
          <Text flex="1" minWidth={0} fontSize="xs" color="status.error" wordBreak="break-word">
            {error}
          </Text>
          {onRetry ? (
            <Button
              data-testid="db-connections-retry"
              size="xs"
              variant="ghost"
              color="accent.default"
              flexShrink={0}
              onClick={onRetry}
            >
              Retry
            </Button>
          ) : null}
        </Flex>
      ) : null}

      <Box flex="1" minHeight={0} overflowY="auto">
        {loading ? (
          <Flex data-testid="db-connections-loading" direction="column" gap={2} p={3}>
            <Skeleton height="16px" />
            <Skeleton height="16px" />
            <Skeleton height="16px" />
          </Flex>
        ) : connections.length === 0 ? (
          <Flex
            data-testid="db-connections-empty"
            direction="column"
            align="center"
            justify="center"
            gap={2}
            height="100%"
            p={4}
          >
            <Text fontSize="xs" color="fg.muted" textAlign="center">
              No connections yet. Add a PostgreSQL connection to get started.
            </Text>
            <Button
              data-testid="db-connection-new"
              size="sm"
              variant="solid"
              bg="accent.default"
              color="accent.contrast"
              onClick={onNew}
            >
              <LuPlus size={13} />
              Add connection
            </Button>
          </Flex>
        ) : (
          <Box role="list" aria-label="Saved connections">
            {connections.map((view) => {
              const status = statusFor(view);
              const isActive = view.id === activeConnectionId;
              return (
                <Box
                  key={view.id}
                  role="listitem"
                  data-testid={`db-connection-row-${view.id}`}
                  data-active={isActive}
                  px={3}
                  py={2}
                  borderBottomWidth="1px"
                  borderColor="border.subtle"
                  bg={isActive ? 'accent.subtle' : undefined}
                  cursor="pointer"
                  tabIndex={0}
                  aria-current={isActive ? 'true' : undefined}
                  _hover={{ bg: isActive ? 'accent.subtle' : 'bg.hover' }}
                  onClick={() => onSelect(view)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(view);
                    }
                  }}
                >
                  <HStack gap={2} align="center">
                    <Box
                      data-testid={`db-connection-status-${view.id}`}
                      data-status={status}
                      aria-label={`Status: ${STATUS_LABEL[status]}`}
                      title={STATUS_LABEL[status]}
                      flexShrink={0}
                      boxSize="8px"
                      borderRadius="full"
                      bg={STATUS_TOKEN[status]}
                    />
                    <Text
                      data-testid="db-connection-name"
                      flex="1"
                      minWidth={0}
                      fontSize="xs"
                      fontWeight="600"
                      color="fg.default"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      title={view.name}
                    >
                      {view.name}
                    </Text>
                    <Text
                      data-testid="db-connection-ssl"
                      flexShrink={0}
                      fontSize="2xs"
                      color="fg.muted"
                      textTransform="uppercase"
                    >
                      {view.sslMode}
                    </Text>
                  </HStack>
                  <Text
                    data-testid="db-connection-target"
                    fontSize="2xs"
                    color="fg.muted"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    title={`${view.user}@${view.host}:${view.port}/${view.database}`}
                  >
                    {view.user}@{view.host}:{view.port}/{view.database}
                  </Text>

                  <HStack gap={1} mt={1} justify="flex-end">
                    <Button
                      data-testid={`db-connection-edit-${view.id}`}
                      size="xs"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEdit(view);
                      }}
                    >
                      Edit
                    </Button>
                    {pendingDeleteId === view.id ? (
                      <Button
                        data-testid="db-connection-delete-confirm"
                        size="xs"
                        variant="solid"
                        colorPalette="red"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPendingDeleteId(null);
                          onDelete(view);
                        }}
                      >
                        Confirm
                      </Button>
                    ) : (
                      <Button
                        data-testid={`db-connection-delete-${view.id}`}
                        size="xs"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPendingDeleteId(view.id);
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </HStack>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    </Flex>
  );
};
