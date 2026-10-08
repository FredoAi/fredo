import React from 'react';
import { Box, VStack, HStack, Text, Badge, Link } from '@chakra-ui/react';
import { LuBookOpen } from 'react-icons/lu';
import type { DocsViewerState } from '../DocsViewerFeature';

interface Props {
  state: DocsViewerState;
}

const EmptyState: React.FC = () => (
  <Box flex={1} display="flex" alignItems="center" justifyContent="center" p={6}>
    <VStack gap={2}>
      <LuBookOpen size={32} color="var(--text-secondary)" />
      <Text color="var(--text-secondary)" fontSize="sm" textAlign="center">
        Waiting for documentation tool calls…
      </Text>
    </VStack>
  </Box>
);

const DocResultCard: React.FC<{ result: any; index: number }> = ({ result, index }) => (
  <Box
    border="1px solid var(--border-subtle)"
    borderRadius="md"
    p={3}
    bg="var(--bg-secondary)"
    _hover={{ bg: 'var(--bg-tertiary)' }}
  >
    <HStack mb={1} justify="space-between">
      <Text fontSize="xs" color="var(--text-secondary)" fontFamily="var(--font-secondary)">
        #{index + 1}
      </Text>
      {result.url && (
        <Link href={result.url} target="_blank" fontSize="xs" color="var(--accent-primary)">
          Open ↗
        </Link>
      )}
    </HStack>
    {result.title && (
      <Text fontSize="sm" fontWeight="semibold" color="var(--text-primary)" mb={1}>
        {result.title}
      </Text>
    )}
    {result.description && (
      <Text fontSize="xs" color="var(--text-secondary)" lineClamp={3}>
        {result.description}
      </Text>
    )}
    {result.content && !result.description && (
      <Text fontSize="xs" color="var(--text-secondary)" lineClamp={4}>
        {result.content}
      </Text>
    )}
  </Box>
);

export const DocsViewerPanel: React.FC<Props> = ({ state }) => {
  if (!state.query && state.results.length === 0) return <EmptyState />;

  const serverLabel = state.source === 'angular' ? 'Angular' : 'Microsoft Learn';
  const serverColor = state.source === 'angular' ? 'red' : 'blue';

  return (
    <Box display="flex" flexDirection="column" height="100%" overflow="hidden">
      {/* Header */}
      <HStack px={4} py={3} borderBottom="1px solid var(--border-subtle)" gap={2} flexShrink={0}>
        <LuBookOpen size={14} />
        <Text fontSize="sm" fontWeight="semibold" color="var(--text-primary)" truncate>
          {state.query ? `"${state.query}"` : 'Docs'}
        </Text>
        <Badge colorPalette={serverColor as any} size="sm" ml="auto">{serverLabel}</Badge>
        {state.timestamp && (
          <Text fontSize="xs" color="var(--text-secondary)">
            {new Date(state.timestamp).toLocaleTimeString()}
          </Text>
        )}
      </HStack>

      {/* Results */}
      <Box flex={1} overflow="auto" p={3}>
        {state.results.length === 0 ? (
          <Text fontSize="sm" color="var(--text-secondary)">Awaiting results…</Text>
        ) : (
          <VStack gap={2} align="stretch">
            <Text fontSize="xs" color="var(--text-secondary)">
              {state.results.length} result{state.results.length !== 1 ? 's' : ''}
            </Text>
            {state.results.map((result, i) => (
              <DocResultCard key={i} result={result} index={i} />
            ))}
          </VStack>
        )}
      </Box>
    </Box>
  );
};
