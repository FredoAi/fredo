import React from 'react';
import { Box, Text, HStack, VStack, Badge } from '@chakra-ui/react';
import {
  LuBug, LuCircleCheck, LuFileText, LuFlag, LuLayers, LuListTodo,
} from 'react-icons/lu';
import type { UnifiedWorkItem } from '../types';

interface UnifiedItemCardProps {
  item: UnifiedWorkItem;
  onClick: () => void;
}

function getIcon(source: string, type: string) {
  const t = type.toLowerCase();
  if (t.includes('bug')) return LuBug;
  if (t.includes('task')) return LuCircleCheck;
  if (t.includes('story')) return LuFileText;
  if (t.includes('feature')) return LuLayers;
  if (t.includes('epic')) return LuFlag;
  return LuListTodo;
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('active') || s.includes('in progress')) return 'blue';
  if (s.includes('new') || s.includes('open') || s.includes('to do')) return 'purple';
  if (s.includes('resolved')) return 'yellow';
  if (s.includes('done') || s.includes('closed') || s.includes('completed')) return 'green';
  return 'gray';
}

function priorityColor(priority?: string | number): string | null {
  if (priority === undefined || priority === null) return null;
  const p = String(priority).toLowerCase();
  if (p === '1' || p === 'critical') return 'var(--status-error)';
  if (p === '2' || p === 'high') return 'var(--status-warning)';
  return null;
}

export const UnifiedItemCard: React.FC<UnifiedItemCardProps> = ({ item, onClick }) => {
  const Icon = getIcon(item.source, item.type);
  const pColor = priorityColor(item.priority);
  const isAzdo = item.source === 'azdo';

  return (
    <Box
      onClick={onClick}
      cursor="pointer"
      padding={4}
      borderRadius="md"
      borderWidth="1px"
      borderColor="var(--border-color)"
      background="var(--card-bg)"
      transition="all 0.2s"
      _hover={{
        background: 'var(--card-hover-bg)',
        borderColor: 'var(--accent-primary)',
        transform: 'translateY(-2px)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      }}
    >
      <VStack align="stretch" gap={3}>
        {/* Row 1: source badge + id + type icon + priority indicator */}
        <HStack justify="space-between">
          <HStack gap={2} flexShrink={0}>
            {/* Source badge */}
            <Badge
              colorPalette={isAzdo ? 'purple' : 'blue'}
              variant="subtle"
              size="xs"
              textTransform="uppercase"
              letterSpacing="0.05em"
            >
              {isAzdo ? 'AzDo' : 'Jira'}
            </Badge>
            <Icon size={16} color="var(--accent-primary)" />
            <Text fontSize="xs" fontWeight="700" color="var(--accent-primary)">
              {item.id}
            </Text>
          </HStack>
          {pColor && <LuFlag size={13} color={pColor} />}
        </HStack>

        {/* Row 2: title */}
        <Text
          fontSize="sm"
          fontWeight="600"
          color="var(--text-primary)"
          lineClamp={2}
          lineHeight="1.4"
        >
          {item.title}
        </Text>

        {/* Row 3: type + status + project */}
        <HStack justify="space-between" align="center" flexWrap="wrap" gap={1}>
          <Text fontSize="xs" color="var(--text-secondary)" textTransform="capitalize">
            {item.type}
          </Text>
          <Badge colorPalette={statusColor(item.status)} variant="subtle" size="sm">
            {item.status}
          </Badge>
        </HStack>

        {item.projectName && (
          <Text fontSize="xs" color="var(--text-secondary)" lineClamp={1}>
            {item.projectName}
          </Text>
        )}
      </VStack>
    </Box>
  );
};
