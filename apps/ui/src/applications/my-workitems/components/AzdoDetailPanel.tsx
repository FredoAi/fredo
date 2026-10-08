/**
 * Azure DevOps work item detail panel — rendered inline (not in a modal)
 */

import React from 'react';
import {
  Box, Button, Text, VStack, HStack, Spinner, Badge,
} from '@chakra-ui/react';
import {
  LuArrowLeft, LuExternalLink, LuMessageCircle, LuCircleX,
  LuCalendar, LuUser, LuTag,
} from 'react-icons/lu';
import { useWorkItemDetails } from '../hooks/useWorkItemDetails';
import { buildAzdoPrompt } from '../utils/promptBuilder';
import { getOrg } from '../../../shared/utils/patStorage';
import { toaster } from '../../../shared/components/ui/toaster';

interface AzdoDetailPanelProps {
  workItemId: number;
  onBack: () => void;
  onClose?: () => void;
}

function stripHtml(html: string | undefined): string {
  if (!html) return 'Not specified';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').trim() || 'Not specified';
}

function fmt(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function priorityLabel(p?: number): string {
  if (p === 1) return 'Critical';
  if (p === 2) return 'High';
  if (p === 3) return 'Medium';
  if (p === 4) return 'Low';
  return 'Unknown';
}

function priorityPalette(p?: number): string {
  if (p === 1) return 'red';
  if (p === 2) return 'orange';
  if (p === 3) return 'blue';
  return 'gray';
}

function statePalette(state: string): string {
  const s = state.toLowerCase();
  if (s.includes('active')) return 'blue';
  if (s.includes('new')) return 'purple';
  if (s.includes('resolved')) return 'yellow';
  if (s.includes('done') || s.includes('closed') || s.includes('completed')) return 'green';
  return 'gray';
}

export const AzdoDetailPanel: React.FC<AzdoDetailPanelProps> = ({ workItemId, onBack, onClose }) => {
  const { workItem, isLoading, error } = useWorkItemDetails(workItemId);

  const handleWorkWithAgent = () => {
    if (!workItem) return;
    const prompt = buildAzdoPrompt(workItem);
    window.dispatchEvent(new CustomEvent('Fredo:inject-chat', { detail: { message: prompt } }));
      toaster.create({ title: 'Sent to Agent', type: 'success', duration: 3000 });
    onClose?.();
  };

  const handleOpenInAzDo = () => {
    const org = getOrg();
    window.open(`https://dev.azure.com/${org}/_workitems/edit/${workItemId}`, '_blank');
  };

  if (isLoading) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" minHeight="300px">
        <VStack gap={4}>
          <Spinner size="xl" color="var(--accent-primary)" borderWidth="4px" />
          <Text fontSize="md" color="var(--text-primary)">Loading work item…</Text>
        </VStack>
      </Box>
    );
  }

  if (error || !workItem) {
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

  const f = workItem.fields;
  const title = f['System.Title'];
  const type = f['System.WorkItemType'];
  const state = f['System.State'];
  const priority = f['Microsoft.VSTS.Common.Priority'];
  const assignedTo = f['System.AssignedTo']?.displayName;
  const createdBy = f['System.CreatedBy']?.displayName;
  const areaPath = f['System.AreaPath'];
  const iteration = f['System.IterationPath'];
  const tags = f['System.Tags'];
  const description = stripHtml(f['System.Description']);
  const criteria = stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria']);
  const createdDate = f['System.CreatedDate'];
  const changedDate = f['System.ChangedDate'];

  return (
    <Box padding={5} overflowY="auto" height="100%">
      <VStack gap={4} align="stretch">
        {/* ── Back + actions ── */}
        <HStack justify="space-between" flexWrap="wrap" gap={2}>
          <Button size="sm" variant="ghost" colorPalette="blue" onClick={onBack}>
            <HStack gap={1}><LuArrowLeft size={14} /><span>Back</span></HStack>
          </Button>
          <HStack gap={2}>
            <Button size="sm" variant="outline" colorPalette="gray" onClick={handleOpenInAzDo}>
              <HStack gap={1}><LuExternalLink size={14} /><span>Open in AzDo</span></HStack>
            </Button>
            <Button size="sm" colorPalette="purple" onClick={handleWorkWithAgent}>
              <HStack gap={1}><LuMessageCircle size={14} /><span>Work with Agent</span></HStack>
            </Button>
          </HStack>
        </HStack>

        {/* ── Header ── */}
        <VStack align="stretch" gap={2}>
          <HStack gap={2} flexWrap="wrap">
            <Badge colorPalette="purple" variant="subtle" size="sm">AzDo</Badge>
            <Badge colorPalette={statePalette(state)} variant="subtle" size="sm">{state}</Badge>
            <Badge colorPalette="gray" variant="subtle" size="sm">{type}</Badge>
            {priority !== undefined && (
              <Badge colorPalette={priorityPalette(priority)} variant="subtle" size="sm">
                {priorityLabel(priority)}
              </Badge>
            )}
          </HStack>
          <Text fontSize="xs" color="var(--accent-primary)" fontWeight="700">
            #{workItemId}
          </Text>
          <Text fontSize="lg" fontWeight="700" color="var(--text-primary)" lineHeight="1.4">
            {title}
          </Text>
        </VStack>

        {/* ── Meta grid ── */}
        <SimpleMetaRow icon={LuUser} label="Assigned To" value={assignedTo ?? '—'} />
        <SimpleMetaRow icon={LuUser} label="Created By" value={createdBy ?? '—'} />
        <SimpleMetaRow icon={LuCalendar} label="Created" value={fmt(createdDate)} />
        <SimpleMetaRow icon={LuCalendar} label="Updated" value={fmt(changedDate)} />
        {areaPath && <SimpleMetaRow icon={LuTag} label="Area" value={areaPath} />}
        {iteration && <SimpleMetaRow icon={LuTag} label="Iteration" value={iteration} />}
        {tags && <SimpleMetaRow icon={LuTag} label="Tags" value={tags} />}

        {/* ── Description ── */}
        <Section title="Description" body={description} />
        <Section title="Acceptance Criteria" body={criteria} />
      </VStack>
    </Box>
  );
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SimpleMetaRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <HStack gap={3} align="flex-start">
      <Icon size={14} color="var(--text-secondary)" style={{ marginTop: 2, flexShrink: 0 }} />
      <Text fontSize="xs" color="var(--text-secondary)" flexShrink={0} minW="80px">{label}</Text>
      <Text fontSize="xs" color="var(--text-primary)">{value}</Text>
    </HStack>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  if (!body || body === 'Not specified') return null;
  return (
    <VStack align="stretch" gap={1}>
      <Text fontSize="sm" fontWeight="600" color="var(--text-secondary)">{title}</Text>
      <Box
        padding={3}
        borderRadius="md"
        background="var(--card-bg)"
        borderWidth="1px"
        borderColor="var(--border-color)"
      >
        <Text fontSize="sm" color="var(--text-primary)" whiteSpace="pre-wrap">{body}</Text>
      </Box>
    </VStack>
  );
}
