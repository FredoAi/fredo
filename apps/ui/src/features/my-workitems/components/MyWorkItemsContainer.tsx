/**
 * MyWorkItemsContainer
 * 
 * Unified view for Azure DevOps work items and Jira issues.
 * Features:
 *  - Source tabs: All | Azure DevOps | Jira
 *  - Status filter pills per source
 *  - Cards show source badge so you always know where an item is from
 *  - Clicking a card opens an inline detail view with "Work with Agent" CTA
 */

import React, { useState, useMemo } from 'react';
import {
  Box, Text, VStack, SimpleGrid, Spinner, Button, HStack, Badge,
} from '@chakra-ui/react';
import {
  LuRefreshCw, LuCircleCheck, LuTriangleAlert,
} from 'react-icons/lu';
import { useMyWorkItems } from '../hooks/useMyWorkItems';
import { UnifiedItemCard } from './UnifiedItemCard';
import { AzdoDetailPanel } from './AzdoDetailPanel';
import { JiraDetailPanel } from './JiraDetailPanel';
import type { UnifiedWorkItem, SourceFilter, DetailTarget } from '../types';
import { toaster } from '../../../shared/components/ui/toaster';

interface MyWorkItemsContainerProps {
  /** Set by feature class when Agent navigates directly to a specific item */
  initialDetail?: DetailTarget;
  onClose?: () => void;
}

const SOURCE_TABS: { label: string; value: SourceFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Azure DevOps', value: 'azdo' },
  { label: 'Jira', value: 'jira' },
];

function getStatusOptions(items: UnifiedWorkItem[], source: SourceFilter): string[] {
  const filtered = source === 'all' ? items : items.filter(i => i.source === source);
  const statuses = Array.from(new Set(filtered.map(i => i.status)));
  return ['All', ...statuses.sort()];
}

export const MyWorkItemsContainer: React.FC<MyWorkItemsContainerProps> = ({
  initialDetail,
  onClose,
}) => {
  const { items, azdoError, jiraError, isMockJira, isLoading, refetch } = useMyWorkItems();
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [detail, setDetail] = useState<DetailTarget | null>(initialDetail ?? null);

  const handleRefresh = async () => {
    await refetch();
    toaster.create({ title: 'Refreshed', description: 'Work items updated', type: 'success', duration: 2000 });
  };

  // ── Filter items ─────────────────────────────────────────────────────────
  const visibleItems = useMemo(() => {
    return items.filter(item => {
      if (sourceFilter !== 'all' && item.source !== sourceFilter) return false;
      if (statusFilter !== 'All' && item.status !== statusFilter) return false;
      return true;
    });
  }, [items, sourceFilter, statusFilter]);

  const statusOptions = useMemo(
    () => getStatusOptions(items, sourceFilter),
    [items, sourceFilter]
  );

  // ── Detail view ──────────────────────────────────────────────────────────
  if (detail) {
    if (detail.source === 'azdo') {
      return (
        <AzdoDetailPanel
          workItemId={Number(detail.id)}
          onBack={() => setDetail(null)}
          onClose={onClose}
        />
      );
    }
    return (
      <JiraDetailPanel
        issueKey={detail.id}
        onBack={() => setDetail(null)}
        onClose={onClose}
      />
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (isLoading && items.length === 0) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" minHeight="400px" padding={8}>
        <VStack gap={4}>
          <Spinner size="xl" color="var(--accent-primary)" borderWidth="4px" />
          <Text fontSize="md" color="var(--text-primary)" fontWeight="medium">
            Loading work items…
          </Text>
        </VStack>
      </Box>
    );
  }

  // ── Count helpers ─────────────────────────────────────────────────────────
  const azdoCount = items.filter(i => i.source === 'azdo').length;
  const jiraCount = items.filter(i => i.source === 'jira').length;

  return (
    <Box padding={4} overflowY="auto" height="100%">
      <VStack gap={3} align="stretch">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <HStack justify="space-between" align="center">
          <VStack gap={0} align="flex-start">
            <Text fontSize="lg" fontWeight="700" color="var(--text-primary)">
              My Work Items
            </Text>
            <Text fontSize="xs" color="var(--text-secondary)">
              {azdoCount} AzDo · {jiraCount} Jira
            </Text>
          </VStack>

          <Button
            size="sm"
            variant="ghost"
            colorPalette="blue"
            loading={isLoading}
            onClick={handleRefresh}
          >
            <HStack gap={1}><LuRefreshCw size={14} /><span>Refresh</span></HStack>
          </Button>
        </HStack>

        {/* ── Error banners ──────────────────────────────────────────── */}
        {azdoError && <ErrorBanner source="Azure DevOps" message={azdoError} />}
        {jiraError && <ErrorBanner source="Jira" message={jiraError} />}

        {/* ── Source tabs ────────────────────────────────────────────── */}
        <HStack gap={2} flexWrap="wrap">
          {SOURCE_TABS.map(tab => {
            const count =
              tab.value === 'all' ? items.length :
              tab.value === 'azdo' ? azdoCount :
              jiraCount;
            const active = sourceFilter === tab.value;
            return (
              <Button
                key={tab.value}
                size="sm"
                variant={active ? 'solid' : 'outline'}
                colorPalette={
                  tab.value === 'azdo' ? 'purple' :
                  tab.value === 'jira' ? 'blue' :
                  'gray'
                }
                onClick={() => {
                  setSourceFilter(tab.value);
                  setStatusFilter('All');
                }}
                borderRadius="full"
                color={active ? 'white' : 'var(--text-primary)'}
                borderColor={active ? undefined : 'var(--border-color)'}
              >
                {tab.label}
                <Text
                  as="span"
                  ml={1.5}
                  fontSize="xs"
                  fontWeight="700"
                  px={1.5}
                  py={0.5}
                  borderRadius="full"
                  background={active ? 'rgba(255,255,255,0.25)' : 'var(--card-hover-bg)'}
                  color={active ? 'white' : 'var(--text-primary)'}
                >
                  {count}
                </Text>
              </Button>
            );
          })}
        </HStack>

        {/* ── Status filter pills ─────────────────────────────────────── */}
        {statusOptions.length > 1 && (
          <HStack gap={1} flexWrap="wrap">
            {statusOptions.map(s => (
              <Button
                key={s}
                size="xs"
                variant={statusFilter === s ? 'solid' : 'outline'}
                colorPalette={statusFilter === s ? 'purple' : 'gray'}
                onClick={() => setStatusFilter(s)}
                borderRadius="full"
                color={statusFilter === s ? 'white' : 'var(--text-secondary)'}
                borderColor={statusFilter === s ? undefined : 'var(--border-color)'}
              >
                {s}
              </Button>
            ))}
          </HStack>
        )}

        {/* ── Empty state ─────────────────────────────────────────────── */}
        {visibleItems.length === 0 && !isLoading && (
          <Box padding={8}>
            <VStack gap={3}>
              <LuCircleCheck size={48} color="var(--status-success)" />
              <Text fontSize="lg" fontWeight="600" color="var(--text-primary)">
                No items to display
              </Text>
              <Text fontSize="sm" color="var(--text-secondary)" textAlign="center">
                {items.length > 0
                  ? `No items match the current filter — try "All"`
                  : 'You have no work items assigned to you right now.'}
              </Text>
              <Button size="sm" variant="ghost" colorPalette="blue" onClick={handleRefresh}>
                <HStack gap={1}><LuRefreshCw size={14} /><span>Refresh</span></HStack>
              </Button>
            </VStack>
          </Box>
        )}

        {/* ── Card grid ───────────────────────────────────────────────── */}
        {visibleItems.length > 0 && (
          <SimpleGrid columns={{ base: 1, md: 2 }} gap={3}>
            {visibleItems.map(item => (
              <UnifiedItemCard
                key={`${item.source}-${item.id}`}
                item={item}
                onClick={() => setDetail({ source: item.source, id: item.id })}
              />
            ))}
          </SimpleGrid>
        )}
      </VStack>
    </Box>
  );
};

// ─── Error banner helper ──────────────────────────────────────────────────────

function ErrorBanner({ source, message }: { source: string; message: string }) {
  return (
    <HStack
      gap={3}
      padding={3}
      borderRadius="md"
      background="rgba(var(--status-error-rgb, 239,68,68), 0.08)"
      borderWidth="1px"
      borderColor="var(--status-error)"
    >
      <LuTriangleAlert size={16} color="var(--status-error)" />
      <Text fontSize="xs" color="var(--text-primary)">
        <Text as="span" fontWeight="600">{source}:</Text>{' '}
        {message}
      </Text>
    </HStack>
  );
}
