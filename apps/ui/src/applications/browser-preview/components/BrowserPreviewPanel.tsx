import React from 'react';
import { Box, VStack, HStack, Text, Badge, Image, Tabs } from '@chakra-ui/react';
import { LuMonitor, LuNetwork, LuTerminal } from 'react-icons/lu';
import type { BrowserPreviewState } from '../BrowserPreviewFeature';

interface Props {
  state: BrowserPreviewState;
}

const EmptyState: React.FC = () => (
  <Box flex={1} display="flex" alignItems="center" justifyContent="center" p={6}>
    <VStack gap={2}>
      <LuMonitor size={32} color="var(--text-secondary)" />
      <Text color="var(--text-secondary)" fontSize="sm" textAlign="center">
        Waiting for browser tool calls…
      </Text>
    </VStack>
  </Box>
);

const NetworkEntry: React.FC<{ req: any }> = ({ req }) => (
  <Box
    px={3}
    py={1.5}
    borderBottom="1px solid var(--border-subtle)"
    fontSize="xs"
    fontFamily="var(--font-secondary)"
  >
    <HStack gap={2}>
      <Badge size="sm" colorPalette={req.status >= 400 ? 'red' : 'green'}>
        {req.status ?? '—'}
      </Badge>
      <Text color="var(--text-secondary)" truncate>{req.method ?? 'GET'}</Text>
      <Text color="var(--text-primary)" truncate flex={1}>{req.url}</Text>
    </HStack>
  </Box>
);

const ConsoleEntry: React.FC<{ entry: any }> = ({ entry }) => {
  const color = entry.level === 'error' ? 'red.400' : entry.level === 'warn' ? 'yellow.400' : 'var(--text-primary)';
  return (
    <Box
      px={3}
      py={1}
      fontSize="xs"
      fontFamily="var(--font-secondary)"
      color={color}
      borderBottom="1px solid var(--border-subtle)"
    >
      [{entry.level ?? 'log'}] {entry.text ?? JSON.stringify(entry)}
    </Box>
  );
};

export const BrowserPreviewPanel: React.FC<Props> = ({ state }) => {
  if (!state.toolName && !state.screenshotUrl && state.networkRequests.length === 0 && state.consoleLogs.length === 0) {
    return <EmptyState />;
  }

  const serverLabel = state.toolName?.startsWith('playwright') ? 'Playwright' : 'Chrome DevTools';
  const serverColor = state.toolName?.startsWith('playwright') ? 'green' : 'orange';

  return (
    <Box display="flex" flexDirection="column" height="100%" overflow="hidden">
      {/* Header */}
      <HStack px={4} py={3} borderBottom="1px solid var(--border-subtle)" gap={2} flexShrink={0}>
        <LuMonitor size={14} />
        <Text fontSize="sm" fontWeight="semibold" color="var(--text-primary)">
          {state.currentUrl ?? 'Browser'}
        </Text>
        <Badge colorPalette={serverColor as any} size="sm" ml="auto">{serverLabel}</Badge>
        {state.timestamp && (
          <Text fontSize="xs" color="var(--text-secondary)">
            {new Date(state.timestamp).toLocaleTimeString()}
          </Text>
        )}
      </HStack>

      {/* Tabs */}
      <Box flex={1} overflow="hidden" display="flex" flexDirection="column">
        <Tabs.Root defaultValue="screenshot" size="sm" display="flex" flexDirection="column" flex={1}>
          <Tabs.List flexShrink={0} px={2}>
            <Tabs.Trigger value="screenshot"><LuMonitor size={12} />&nbsp;Screenshot</Tabs.Trigger>
            <Tabs.Trigger value="network">
              <LuNetwork size={12} />&nbsp;Network
              {state.networkRequests.length > 0 && (
                <Badge size="sm" ml={1} colorPalette="blue">{state.networkRequests.length}</Badge>
              )}
            </Tabs.Trigger>
            <Tabs.Trigger value="console">
              <LuTerminal size={12} />&nbsp;Console
              {state.consoleLogs.length > 0 && (
                <Badge size="sm" ml={1} colorPalette="gray">{state.consoleLogs.length}</Badge>
              )}
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="screenshot" flex={1} overflow="auto" p={2}>
            {state.screenshotUrl ? (
              <Image src={state.screenshotUrl} alt="Browser screenshot" maxW="100%" borderRadius="md" />
            ) : (
              <Text fontSize="sm" color="var(--text-secondary)" p={2}>No screenshot captured yet.</Text>
            )}
          </Tabs.Content>

          <Tabs.Content value="network" flex={1} overflow="auto" p={0}>
            {state.networkRequests.length === 0 ? (
              <Text fontSize="sm" color="var(--text-secondary)" p={4}>No network requests captured.</Text>
            ) : (
              <VStack gap={0} align="stretch">
                {state.networkRequests.map((req, i) => <NetworkEntry key={i} req={req} />)}
              </VStack>
            )}
          </Tabs.Content>

          <Tabs.Content value="console" flex={1} overflow="auto" p={0}>
            {state.consoleLogs.length === 0 ? (
              <Text fontSize="sm" color="var(--text-secondary)" p={4}>No console messages captured.</Text>
            ) : (
              <VStack gap={0} align="stretch">
                {state.consoleLogs.map((entry, i) => <ConsoleEntry key={i} entry={entry} />)}
              </VStack>
            )}
          </Tabs.Content>
        </Tabs.Root>
      </Box>
    </Box>
  );
};
