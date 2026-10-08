import React from 'react';
import { Box, HStack, Text, Button, VStack } from '@chakra-ui/react';
import { LuCloudLightning, LuTicket } from 'react-icons/lu';
import { CreateWorkItemForm } from './azdo/CreateWorkItemForm';
import { WorkItemSuccess } from './azdo/WorkItemSuccess';
import { CreateIssueForm } from './jira/CreateIssueForm';
import { IssueCreatedSuccess } from './jira/IssueCreatedSuccess';
import type { CreateWorkItemData, CreateIssueData, JiraIssueCreated, WorkItemPlatform } from '../types';

interface UnifiedCreateWorkItemViewProps {
  platform: WorkItemPlatform;
  mode: 'form' | 'success';

  azdoFormData: Partial<CreateWorkItemData>;
  azdoUpdateCounter: number;
  azdoSuccessData?: { workItemId: number; workItemUrl: string };

  jiraFormData: Partial<CreateIssueData>;
  jiraUpdateCounter: number;
  jiraSuccessData?: JiraIssueCreated;

  onPlatformChange: (p: WorkItemPlatform) => void;
  onAzdoSuccess: (workItemId: number, workItemUrl: string) => void;
  onJiraSuccess: (created: JiraIssueCreated) => void;
  onCreateAnother: () => void;
  onViewWorkItem: () => void;
  onClose: () => void;
}

export const UnifiedCreateWorkItemView: React.FC<UnifiedCreateWorkItemViewProps> = ({
  platform,
  mode,
  azdoFormData,
  azdoUpdateCounter,
  azdoSuccessData,
  jiraFormData,
  jiraUpdateCounter,
  jiraSuccessData,
  onPlatformChange,
  onAzdoSuccess,
  onJiraSuccess,
  onCreateAnother,
  onViewWorkItem,
  onClose,
}) => {
  // ─── Success screens ───────────────────────────────────────────────────────
  if (mode === 'success') {
    if (platform === 'azdo' && azdoSuccessData) {
      return (
        <WorkItemSuccess
          workItemId={azdoSuccessData.workItemId}
          workItemUrl={azdoSuccessData.workItemUrl}
          onCreateAnother={onCreateAnother}
          onViewWorkItem={onViewWorkItem}
          onClose={onClose}
        />
      );
    }

    if (platform === 'jira' && jiraSuccessData) {
      return (
        <IssueCreatedSuccess
          created={jiraSuccessData}
          onCreateAnother={onCreateAnother}
          onClose={onClose}
        />
      );
    }
  }

  // ─── Form view ─────────────────────────────────────────────────────────────
  return (
    <VStack gap={0} align="stretch" height="100%">
      {/* Platform tabs */}
      <Box
        borderBottomWidth="1px"
        borderColor="var(--border-color)"
        paddingX={4}
        paddingTop={3}
        paddingBottom={0}
        background="var(--header-bg)"
      >
        <HStack gap={1}>
          <PlatformTab
            label="Azure DevOps"
            icon={<LuCloudLightning size={14} />}
            active={platform === 'azdo'}
            onClick={() => onPlatformChange('azdo')}
          />
          <PlatformTab
            label="Jira"
            icon={<LuTicket size={14} />}
            active={platform === 'jira'}
            onClick={() => onPlatformChange('jira')}
          />
        </HStack>
      </Box>

      {/* Form area */}
      <Box flex="1" overflow="auto">
        {platform === 'azdo' ? (
          <CreateWorkItemForm
            initialData={azdoFormData}
            onSuccess={onAzdoSuccess}
            onDataChange={() => {}}
            updateCounter={azdoUpdateCounter}
          />
        ) : (
          <CreateIssueForm
            initialData={jiraFormData}
            onSuccess={onJiraSuccess}
            onDataChange={() => {}}
            updateCounter={jiraUpdateCounter}
          />
        )}
      </Box>
    </VStack>
  );
};

// ─── PlatformTab helper ───────────────────────────────────────────────────────

interface PlatformTabProps {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}

const PlatformTab: React.FC<PlatformTabProps> = ({ label, icon, active, onClick }) => (
  <Button
    size="sm"
    variant="ghost"
    onClick={onClick}
    paddingX={3}
    paddingBottom={2}
    borderRadius="0"
    borderBottomWidth="2px"
    borderBottomColor={active ? 'var(--accent-primary)' : 'transparent'}
    color={active ? 'var(--accent-primary)' : 'var(--text-secondary)'}
    fontWeight={active ? '600' : '400'}
    _hover={{ color: 'var(--text-primary)', background: 'transparent' }}
    transition="all 0.15s"
  >
    <HStack gap={1.5}>
      {icon as React.ReactNode}
      <Text fontSize="sm">{label}</Text>
    </HStack>
  </Button>
);
