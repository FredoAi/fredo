import React from 'react';
import { Box, Tabs, Text, VStack, HStack } from '@chakra-ui/react';
import { LuPalette, LuBrain, LuActivity } from 'react-icons/lu';
import { ThemeSelector } from './ThemeSelector';
import { AnimationSelector } from './AnimationSelector';
import { ModelSelector } from './ModelSelector';
import { TelemetrySettings } from './TelemetrySettings';

export const SettingsPanel: React.FC = () => {
  return (
    <Box
      background="var(--card-bg)"
      borderRadius="lg"
      border="1px solid"
      borderColor="var(--border-color)"
      overflow="hidden"
    >
      <Tabs.Root defaultValue="theming" colorPalette="purple" variant="subtle">
        <Tabs.List
          background="var(--header-bg)"
          borderBottom="1px solid"
          borderColor="var(--border-color)"
          px={2}
          pt={2}
          gap={1}
        >
          <Tabs.Trigger
            value="theming"
            fontSize="sm"
            fontWeight="600"
            color="var(--text-secondary)"
            px={4}
            py={2}
            borderRadius="md"
            _selected={{
              color: 'var(--accent-primary)',
              background: 'rgba(147, 51, 234, 0.12)',
            }}
            _hover={{ color: 'var(--text-primary)' }}
          >
            <HStack gap={1}>
              <LuPalette size={14} />
              <span>Theming</span>
            </HStack>
          </Tabs.Trigger>

          <Tabs.Trigger
            value="ai"
            fontSize="sm"
            fontWeight="600"
            color="var(--text-secondary)"
            px={4}
            py={2}
            borderRadius="md"
            _selected={{
              color: 'var(--accent-primary)',
              background: 'rgba(147, 51, 234, 0.12)',
            }}
            _hover={{ color: 'var(--text-primary)' }}
          >
            <HStack gap={1}>
              <LuBrain size={14} />
              <span>AI Model</span>
            </HStack>
          </Tabs.Trigger>

          <Tabs.Trigger
            value="telemetry"
            fontSize="sm"
            fontWeight="600"
            color="var(--text-secondary)"
            px={4}
            py={2}
            borderRadius="md"
            _selected={{
              color: 'var(--accent-primary)',
              background: 'rgba(147, 51, 234, 0.12)',
            }}
            _hover={{ color: 'var(--text-primary)' }}
          >
            <HStack gap={1}>
              <LuActivity size={14} />
              <span>Telemetry</span>
            </HStack>
          </Tabs.Trigger>
        </Tabs.List>

        {/* Theming tab */}
        <Tabs.Content value="theming">
          <VStack gap={5} align="stretch" p={5}>
            <Box>
              <Text fontSize="xs" fontWeight="700" color="var(--text-secondary)" letterSpacing="wider" textTransform="uppercase" mb={2}>
                Theme
              </Text>
              <ThemeSelector />
            </Box>

            <Box>
              <Text fontSize="xs" fontWeight="700" color="var(--text-secondary)" letterSpacing="wider" textTransform="uppercase" mb={2}>
                Animation Style
              </Text>
              <AnimationSelector />
            </Box>
          </VStack>
        </Tabs.Content>

        {/* AI Model tab */}
        <Tabs.Content value="ai">
          <VStack gap={5} align="stretch" p={5}>
            <Box>
              <Text fontSize="xs" fontWeight="700" color="var(--text-secondary)" letterSpacing="wider" textTransform="uppercase" mb={2}>
                Active Model
              </Text>
              <ModelSelector />
            </Box>
          </VStack>
        </Tabs.Content>

        {/* Telemetry tab */}
        <Tabs.Content value="telemetry">
          <VStack gap={5} align="stretch" p={5}>
            <TelemetrySettings />
          </VStack>
        </Tabs.Content>
      </Tabs.Root>
    </Box>
  );
};
