import React, { useMemo } from 'react';
import { Box, VStack, HStack, Text, Badge, Code } from '@chakra-ui/react';
import { formatDistanceToNow } from 'date-fns';
import { useStream, type FredoEvent } from '../../../shared/contexts/StreamContext';

interface EventTimelineProps {
  namespace?: string;
  resourceName?: string;
  maxEvents?: number;
}

interface GroupedEvent {
  correlationId: string;
  events: FredoEvent[];
  toolName: string;
  startTime: Date;
  endTime?: Date;
}

/**
 * EventTimeline Component
 * Displays kubectl operation timeline for a specific resource
 */
export const EventTimeline: React.FC<EventTimelineProps> = ({
  namespace,
  resourceName,
  maxEvents = 10,
}) => {
  const { events } = useStream();

  // Filter and group events
  const groupedEvents = useMemo(() => {
    // Filter kubectl events for this resource
    const kubectlEvents = events.filter((event) => {
      // Only kubectl tools
      if (!event.toolName?.startsWith('kubectl_')) return false;

      // If namespace/resourceName provided, match them
      if (namespace || resourceName) {
        const input = (event.payload as Record<string, unknown>) || {};
        const matchesNamespace = !namespace || input.namespace === namespace;
        const matchesName = !resourceName ||
          input.name === resourceName ||
          input.pod === resourceName ||
          resourceName.includes(input.name as string); // For pods matching deployment name

        return matchesNamespace && matchesName;
      }

      return true;
    });

    // Group by correlationId
    const groups = new Map<string, GroupedEvent>();

    kubectlEvents.forEach((event) => {
      const corrId = event.correlationId || event.id || `${event.toolName}-${event.timestamp}`;

      if (!groups.has(corrId)) {
        groups.set(corrId, {
          correlationId: corrId,
          events: [],
          toolName: event.toolName || 'unknown',
          startTime: new Date(event.timestamp),
        });
      }

      const group = groups.get(corrId)!;
      group.events.push(event);

      // Update end time
      const eventTime = new Date(event.timestamp);
      if (!group.endTime || eventTime > group.endTime) {
        group.endTime = eventTime;
      }
    });

    // Convert to array and sort by start time (newest first)
    return Array.from(groups.values())
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, maxEvents);
  }, [events, namespace, resourceName, maxEvents]);

  // Get state badge color
  const getStateBadge = (state: string) => {
    const badges = {
      Init: { color: 'blue', icon: '🔵' },
      Update: { color: 'yellow', icon: '🟡' },
      Response: { color: 'green', icon: '🟢' },
      Error: { color: 'red', icon: '🔴' },
    };
    return badges[state as keyof typeof badges] || { color: 'gray', icon: '⚪' };
  };

  // Format tool name for display
  const formatToolName = (toolName: string) => {
    return toolName.replace('kubectl_', '').replace(/_/g, ' ');
  };

  if (groupedEvents.length === 0) {
    return (
      <Box padding={4} textAlign="center" color="var(--text-secondary)">
        <Text fontSize="sm">No recent operations</Text>
        <Text fontSize="xs" marginTop={1}>
          Kubectl actions will appear here
        </Text>
      </Box>
    );
  }

  return (
    <VStack gap={3} align="stretch" maxHeight="400px" overflowY="auto">
      {groupedEvents.map((group) => (
        <Box
          key={group.correlationId}
          padding={3}
          background="var(--card-bg)"
          borderRadius="md"
          borderLeft="3px solid var(--accent-primary)"
        >
          {/* Operation Header */}
          <HStack justifyContent="space-between" marginBottom={2}>
            <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
              {formatToolName(group.toolName)}
            </Text>
            <Text fontSize="xs" color="var(--text-secondary)">
              {formatDistanceToNow(group.startTime, { addSuffix: true })}
            </Text>
          </HStack>

          {/* Event Timeline */}
          <VStack gap={1.5} align="stretch">
            {group.events
              .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
              .map((event, index) => {
                const badge = getStateBadge(event.state);
                const eventPayload = event.payload as Record<string, unknown> | null;
                return (
                  <HStack key={`${event.id}-${index}`} gap={2} fontSize="xs">
                    <Badge colorPalette={badge.color} size="xs" paddingX={1.5}>
                      {badge.icon} {event.state}
                    </Badge>

                    {event.state === 'Update' && eventPayload && (
                      <Text color="var(--text-secondary)" flex={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                        {typeof eventPayload === 'string'
                          ? eventPayload
                          : JSON.stringify(eventPayload)}
                      </Text>
                    )}

                    {event.state === 'Error' && event.error && (
                      <Text color="var(--status-error)" flex={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                        ❌ {event.error.message}
                      </Text>
                    )}

                    {event.state === 'Response' && (
                      <Text color="var(--status-success)" flex={1}>
                        ✅ Completed
                      </Text>
                    )}
                  </HStack>
                );
              })}
          </VStack>

          {/* Expandable Details (Optional) */}
          {group.events.length > 0 && (
            <details style={{ marginTop: '8px' }}>
              <summary style={{ 
                cursor: 'pointer', 
                fontSize: '11px', 
                color: 'var(--text-secondary)',
                userSelect: 'none'
              }}>
                View raw data
              </summary>
              <Code
                display="block"
                padding={2}
                marginTop={2}
                fontSize="10px"
                maxHeight="200px"
                overflowY="auto"
                borderRadius="md"
                background="rgba(0,0,0,0.2)"
              >
                {JSON.stringify(group.events[group.events.length - 1], null, 2)}
              </Code>
            </details>
          )}
        </Box>
      ))}
    </VStack>
  );
};
