import React from 'react';
import { Box, VStack, HStack, Text, Badge, Code, Tabs } from '@chakra-ui/react';
import { LuGitPullRequest, LuSearch, LuFile, LuList } from 'react-icons/lu';
import type { GithubViewerState } from '../GithubViewerFeature';

interface Props {
  state: GithubViewerState;
}

const JsonBlock: React.FC<{ value: any }> = ({ value }) => (
  <Box
    as="pre"
    fontSize="xs"
    fontFamily="var(--font-secondary)"
    bg="var(--bg-secondary)"
    borderRadius="md"
    p={3}
    overflowX="auto"
    whiteSpace="pre-wrap"
    wordBreak="break-all"
    color="var(--text-primary)"
  >
    {JSON.stringify(value, null, 2)}
  </Box>
);

const EmptyState: React.FC = () => (
  <Box flex={1} display="flex" alignItems="center" justifyContent="center" p={6}>
    <VStack gap={2}>
      <LuGitPullRequest size={32} color="var(--text-secondary)" />
      <Text color="var(--text-secondary)" fontSize="sm" textAlign="center">
        Waiting for GitHub tool calls…
      </Text>
    </VStack>
  </Box>
);

export const GithubViewerPanel: React.FC<Props> = ({ state }) => {
  if (!state.lastEvent) return <EmptyState />;

  const { toolName, payload, response, timestamp } = state.lastEvent;

  const toolMeta: Record<string, { label: string; icon: React.ReactNode }> = {
    'pull_request_read':        { label: 'Pull Request', icon: <LuGitPullRequest size={14} /> },
    'get_pull_request':         { label: 'Pull Request', icon: <LuGitPullRequest size={14} /> },
    'get_pull_request_files':   { label: 'PR Files', icon: <LuFile size={14} /> },
    'get_pull_request_diff':    { label: 'PR Diff', icon: <LuFile size={14} /> },
    'get_pull_request_review_comments': { label: 'PR Reviews', icon: <LuGitPullRequest size={14} /> },
    'search_code':              { label: 'Code Search', icon: <LuSearch size={14} /> },
    'get_file_contents':        { label: 'File Contents', icon: <LuFile size={14} /> },
    'list_issues':              { label: 'Issues', icon: <LuList size={14} /> },
  };

  const meta = toolMeta[toolName] ?? { label: toolName, icon: <LuGitPullRequest size={14} /> };

  return (
    <Box display="flex" flexDirection="column" height="100%" overflow="hidden">
      {/* Header */}
      <HStack px={4} py={3} borderBottom="1px solid var(--border-subtle)" gap={2} flexShrink={0}>
        {meta.icon as React.ReactNode}
        <Text fontSize="sm" fontWeight="semibold" color="var(--text-primary)">
          {meta.label}
        </Text>
        <Badge colorPalette="purple" size="sm" ml="auto">GitHub</Badge>
        <Text fontSize="xs" color="var(--text-secondary)">
          {new Date(timestamp).toLocaleTimeString()}
        </Text>
      </HStack>

      {/* Content */}
      <Box flex={1} overflow="auto" p={4}>
        <Tabs.Root defaultValue="response" size="sm">
          <Tabs.List>
            <Tabs.Trigger value="response">Response</Tabs.Trigger>
            <Tabs.Trigger value="input">Input</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="response">
            {response ? (
              <JsonBlock value={response} />
            ) : (
              <Text fontSize="sm" color="var(--text-secondary)" mt={2}>Awaiting response…</Text>
            )}
          </Tabs.Content>
          <Tabs.Content value="input">
            <JsonBlock value={payload ?? {}} />
          </Tabs.Content>
        </Tabs.Root>
      </Box>
    </Box>
  );
};
