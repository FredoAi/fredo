import React from 'react';
import { Box, VStack, HStack, Text, Button } from '@chakra-ui/react';
import { LuCircleCheck, LuExternalLink, LuPlus, LuX } from 'react-icons/lu';

interface WorkItemSuccessProps {
  workItemId: number;
  workItemUrl?: string;
  onCreateAnother: () => void;
  onViewWorkItem: () => void;
  onClose: () => void;
}

export const WorkItemSuccess: React.FC<WorkItemSuccessProps> = ({
  workItemId,
  workItemUrl,
  onCreateAnother,
  onViewWorkItem,
  onClose
}) => {
  const handleOpenInAzureDevOps = () => {
    if (workItemUrl) {
      window.open(workItemUrl, '_blank');
    }
  };

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
        maxWidth="600px"
        width="100%"
        boxShadow="0 4px 24px rgba(0, 0, 0, 0.3)"
      >
        <VStack gap={6} align="stretch">
        {/* Success Icon and Message */}
        <VStack gap={3}>
          <Box
            color="var(--status-success)"
            fontSize="48px"
          >
            <LuCircleCheck />
          </Box>
          <Text
            fontSize="xl"
            fontWeight="600"
            color="var(--text-primary)"
            textAlign="center"
          >
            Work Item Created Successfully
          </Text>
          <Text
            fontSize="md"
            color="var(--text-secondary)"
            textAlign="center"
          >
            Work item #{workItemId} has been created in Azure DevOps
          </Text>
        </VStack>

        {/* Action Buttons */}
        <VStack gap={3}>
          <Button
            onClick={onViewWorkItem}
            width="100%"
            colorPalette="purple"
            variant="solid"
          >
            <HStack gap={2}>
              <LuExternalLink size={16} />
              <span>View Work Item Details</span>
            </HStack>
          </Button>
          
          {workItemUrl && (
            <Button
              onClick={handleOpenInAzureDevOps}
              width="100%"
              variant="outline"
              borderColor="var(--border-color)"
              color="var(--text-primary)"
              _hover={{ bg: 'var(--card-hover-bg)', borderColor: 'var(--accent-primary)' }}
            >
              <HStack gap={2}>
                <LuExternalLink size={16} />
                <span>Open in Azure DevOps</span>
              </HStack>
            </Button>
          )}
          
          <Button
            onClick={onCreateAnother}
            width="100%"
            variant="outline"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            _hover={{ bg: 'var(--card-hover-bg)', borderColor: 'var(--accent-primary)' }}
          >
            <HStack gap={2}>
              <LuPlus size={16} />
              <span>Create Another Work Item</span>
            </HStack>
          </Button>
          
          <Button
            onClick={onClose}
            width="100%"
            variant="ghost"
            color="var(--text-secondary)"
            _hover={{ bg: 'var(--card-hover-bg)', color: 'var(--text-primary)' }}
          >
            <HStack gap={2}>
              <LuX size={16} />
              <span>Close</span>
            </HStack>
          </Button>
        </VStack>
      </VStack>
      </Box>
    </Box>
  );
};
