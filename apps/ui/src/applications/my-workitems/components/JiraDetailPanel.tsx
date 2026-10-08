/**
 * Jira issue detail panel — rendered inline (not in a modal)
 */

import React from 'react';
import {
  Box, Button, Text, VStack, HStack, Spinner, Badge,
} from '@chakra-ui/react';
import {
  LuArrowLeft, LuExternalLink, LuMessageCircle, LuCircleX,
  LuCalendar, LuUser, LuTag,
} from 'react-icons/lu';
import { useJiraIssueDetails } from '../hooks/useJiraIssueDetails';
import { buildJiraPrompt } from '../utils/promptBuilder';
import { toaster } from '../../../shared/components/ui/toaster';

interface JiraDetailPanelProps {
  issueKey: string;
  onBack: () => void;
  onClose?: () => void;
}

function statusPalette(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('in progress')) return 'blue';
  if (s.includes('open') || s.includes('to do')) return 'purple';
  if (s.includes('done') || s.includes('closed')) return 'green';
  return 'gray';
}

function priorityPalette(priority: string): string {
  if (priority === 'Critical') return 'red';
  if (priority === 'High') return 'orange';
  if (priority === 'Medium') return 'blue';
  return 'gray';
}

function fmt(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export const JiraDetailPanel: React.FC<JiraDetailPanelProps> = ({ issueKey, onBack, onClose }) => {
  const { issue, isMockData, isLoading, error } = useJiraIssueDetails(issueKey);

  const handleWorkWithAgent = () => {
    if (!issue) return;
    const prompt = buildJiraPrompt(issue);
    window.dispatchEvent(new CustomEvent('Fredo:inject-chat', { detail: { message: prompt } }));
      toaster.create({ title: 'Sent to Agent', type: 'success', duration: 3000 });
    onClose?.();
  };

  if (isLoading) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" minHeight="300px">
        <VStack gap={4}>
          <Spinner size="xl" color="var(--accent-primary)" borderWidth="4px" />
          <Text fontSize="md" color="var(--text-primary)">Loading issue…</Text>
        </VStack>
      </Box>
    );
  }

  if (error || !issue) {
    return (
      <Box padding={6}>
        <VStack gap={4} align="center">
          <LuCircleX size={48} color="var(--status-error)" />
          <Text fontSize="lg" fontWeight="600" color="var(--text-primary)">Failed to Load</Text>
          <Text fontSize="sm" color="var(--text-secondary)" textAlign="center">{error}</Text>
          <Button onClick={onBack} size="sm" colorPalette="blue">Back to list</Button>
        </VStack>
      </Box>
    );
  }

  return (
    <Box padding={5} overflowY="auto" height="100%">
      <VStack gap={4} align="stretch">
        {/* ── Back + actions ── */}
        <HStack justify="space-between" flexWrap="wrap" gap={2}>
          <Button size="sm" variant="ghost" colorPalette="blue" onClick={onBack}>
            <HStack gap={1}><LuArrowLeft size={14} /><span>Back</span></HStack>
          </Button>
          <HStack gap={2}>
            {issue.url && (
              <Button size="sm" variant="outline" colorPalette="gray" onClick={() => window.open(issue.url, '_blank')}>
                <HStack gap={1}><LuExternalLink size={14} /><span>Open in Jira</span></HStack>
              </Button>
            )}
            <Button size="sm" colorPalette="blue" onClick={handleWorkWithAgent}>
              <HStack gap={1}><LuMessageCircle size={14} /><span>Work with Agent</span></HStack>
            </Button>
          </HStack>
        </HStack>

        {/* ── Header ── */}
        <VStack align="stretch" gap={2}>
          <HStack gap={2} flexWrap="wrap">
            <Badge colorPalette="blue" variant="subtle" size="sm">Jira</Badge>
            {isMockData && <Badge colorPalette="yellow" variant="subtle" size="sm">Mock</Badge>}
            <Badge colorPalette={statusPalette(issue.status)} variant="subtle" size="sm">{issue.status}</Badge>
            <Badge colorPalette="gray" variant="subtle" size="sm">{issue.issueType}</Badge>
            <Badge colorPalette={priorityPalette(issue.priority)} variant="subtle" size="sm">{issue.priority}</Badge>
          </HStack>
          <Text fontSize="xs" color="var(--accent-primary)" fontWeight="700">{issue.key}</Text>
          <Text fontSize="lg" fontWeight="700" color="var(--text-primary)" lineHeight="1.4">
            {issue.summary}
          </Text>
        </VStack>

        {/* ── Meta ── */}
        <SimpleMetaRow icon={LuUser} label="Assignee" value={issue.assignee?.displayName ?? 'Unassigned'} />
        <SimpleMetaRow icon={LuUser} label="Reporter" value={issue.reporter.displayName} />
        <SimpleMetaRow icon={LuTag} label="Project" value={`${issue.projectName} (${issue.projectKey})`} />
        <SimpleMetaRow icon={LuCalendar} label="Created" value={fmt(issue.created)} />
        <SimpleMetaRow icon={LuCalendar} label="Updated" value={fmt(issue.updated)} />
        {issue.labels.length > 0 && (
          <SimpleMetaRow icon={LuTag} label="Labels" value={issue.labels.join(', ')} />
        )}

        {/* ── Description ── */}
        {issue.description && (
          <VStack align="stretch" gap={1}>
            <Text fontSize="sm" fontWeight="600" color="var(--text-secondary)">Description</Text>
            <Box
              padding={3}
              borderRadius="md"
              background="var(--card-bg)"
              borderWidth="1px"
              borderColor="var(--border-color)"
            >
              <Text fontSize="sm" color="var(--text-primary)" whiteSpace="pre-wrap">{issue.description}</Text>
            </Box>
          </VStack>
        )}
      </VStack>
    </Box>
  );
};

// ─── Helper ──────────────────────────────────────────────────────────────────

function SimpleMetaRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <HStack gap={3} align="flex-start">
      <Icon size={14} color="var(--text-secondary)" style={{ marginTop: 2, flexShrink: 0 }} />
      <Text fontSize="xs" color="var(--text-secondary)" flexShrink={0} minW="80px">{label}</Text>
      <Text fontSize="xs" color="var(--text-primary)">{value}</Text>
    </HStack>
  );
}
