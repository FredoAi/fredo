import React from 'react';
import { Box, VStack, HStack, Text, Button, Badge } from '@chakra-ui/react';
import { LuCircleCheck, LuExternalLink, LuPlus } from 'react-icons/lu';
import type { JiraIssueCreated, JiraIssueType } from '../../types';

interface IssueCreatedSuccessProps {
  created: JiraIssueCreated;
  onCreateAnother: () => void;
  onClose: () => void;
}

function typeColor(type: JiraIssueType): string {
  if (type === 'Bug') return 'red';
  if (type === 'Task') return 'blue';
  return 'green';
}

export const IssueCreatedSuccess: React.FC<IssueCreatedSuccessProps> = ({
  created,
  onCreateAnother,
  onClose,
}) => {
  const handleOpen = () => window.open(created.url, '_blank');

  return (
    <Box
      width="100%"
      height="100%"
      display="flex"
      alignItems="center"
      justifyContent="center"
      padding={4}
      background="var(--body-bg)"
    >
      <Box
        padding={8}
        background="var(--card-bg)"
        borderRadius="lg"
        maxWidth="520px"
        width="100%"
        boxShadow="0 4px 24px rgba(0,0,0,.3)"
      >
        <VStack gap={6} align="stretch">
          {/* Icon + heading */}
          <VStack gap={3}>
            <Box color="var(--status-success)" fontSize="48px">
              <LuCircleCheck />
            </Box>
            <Text fontSize="xl" fontWeight="600" color="var(--text-primary)" textAlign="center">
              Issue Created Successfully
            </Text>
            {created.isMockData && (
              <Badge colorPalette="yellow" variant="subtle">Mock Data</Badge>
            )}
          </VStack>

          {/* Key card */}
          <Box
            padding={4}
            borderRadius="md"
            background="var(--body-bg)"
            borderWidth="1px"
            borderColor="var(--border-color)"
          >
            <VStack gap={3} align="stretch">
              <HStack justify="space-between">
                <Text fontSize="sm" color="var(--text-secondary)">Issue Key</Text>
                <HStack gap={2}>
                  <Badge colorPalette={typeColor(created.issueType)} variant="subtle">
                    {created.issueType}
                  </Badge>
                  <Text fontSize="sm" fontWeight="700" color="var(--accent-primary)">
                    {created.key}
                  </Text>
                </HStack>
              </HStack>
              <Text fontSize="sm" color="var(--text-primary)" fontWeight="500">
                {created.summary}
              </Text>
            </VStack>
          </Box>

          {/* Actions */}
          <VStack gap={3}>
            <Button
              width="100%"
              colorPalette="blue"
              variant="outline"
              onClick={handleOpen}
              size="sm"
            >
              <HStack gap={2}>
                <LuExternalLink size={14} />
                <span>Open in Jira</span>
              </HStack>
            </Button>
            <HStack gap={3} width="100%">
              <Button
                flex="1"
                variant="outline"
                colorPalette="purple"
                onClick={onCreateAnother}
                size="sm"
              >
                <HStack gap={2}>
                  <LuPlus size={14} />
                  <span>Create Another</span>
                </HStack>
              </Button>
              <Button
                flex="1"
                variant="ghost"
                colorPalette="gray"
                onClick={onClose}
                size="sm"
              >
                Done
              </Button>
            </HStack>
          </VStack>
        </VStack>
      </Box>
    </Box>
  );
};
