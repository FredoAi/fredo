/**
 * Fetches work items from both Azure DevOps and Jira in parallel,
 * normalises them into a single UnifiedWorkItem list.
 */

import { useState, useEffect, useCallback } from 'react';
import { getAssignedWorkItems } from '../../../shared/utils/azdoApi';
import { getPAT, getOrg, getProject, getUserProfile } from '../../../shared/utils/patStorage';
import { API_BASE_URL } from '../../../shared/constants/api';
import type { UnifiedWorkItem } from '../types';

interface UseMyWorkItemsReturn {
  items: UnifiedWorkItem[];
  azdoError: string | null;
  jiraError: string | null;
  isMockJira: boolean;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

function mapAzdoItems(raw: any[]): UnifiedWorkItem[] {
  return raw.map((wi) => {
    const f = wi.fields;
    const id = String(wi.id || f['System.Id']);
    return {
      id,
      source: 'azdo',
      title: f['System.Title'] ?? '(no title)',
      type: f['System.WorkItemType'] ?? 'Task',
      status: f['System.State'] ?? 'Unknown',
      priority: f['Microsoft.VSTS.Common.Priority'],
      projectName: f['System.TeamProject'],
      updatedAt: f['System.ChangedDate'],
    };
  });
}

function mapJiraItems(raw: any[]): UnifiedWorkItem[] {
  return raw.map((issue) => ({
    id: issue.key,
    source: 'jira',
    title: issue.summary ?? '(no title)',
    type: issue.issueType ?? 'Task',
    status: issue.status ?? 'Unknown',
    priority: issue.priority,
    projectName: issue.projectName,
    url: issue.url,
    updatedAt: issue.updated,
  }));
}

export function useMyWorkItems(): UseMyWorkItemsReturn {
  const [items, setItems] = useState<UnifiedWorkItem[]>([]);
  const [azdoError, setAzdoError] = useState<string | null>(null);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [isMockJira, setIsMockJira] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setAzdoError(null);
    setJiraError(null);

    // ── AzDo ──────────────────────────────────────────────────────────────────
    const azdoPromise: Promise<UnifiedWorkItem[]> = (async () => {
      const org = getOrg();
      const project = getProject();
      const pat = getPAT();
      const profile = getUserProfile();

      if (!org || !project || !pat || !profile) {
        throw new Error('Azure DevOps credentials not configured');
      }

      const raw = await getAssignedWorkItems(org, pat, project, profile.id);
      return mapAzdoItems(raw);
    })();

    // ── Jira ──────────────────────────────────────────────────────────────────
    const jiraPromise: Promise<{ items: UnifiedWorkItem[]; isMock: boolean }> = (async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/jira/issues/my?maxResults=50`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const data = await response.json();
      if (!data.success) throw new Error('Failed to fetch Jira issues');
      return { items: mapJiraItems(data.issues || []), isMock: data.isMockData || false };
    })();

    // ── Settle both ───────────────────────────────────────────────────────────
    const [azdoResult, jiraResult] = await Promise.allSettled([azdoPromise, jiraPromise]);

    let merged: UnifiedWorkItem[] = [];

    if (azdoResult.status === 'fulfilled') {
      merged = [...merged, ...azdoResult.value];
    } else {
      console.warn('[useMyWorkItems] AzDo error:', azdoResult.reason?.message);
      setAzdoError(azdoResult.reason?.message ?? 'Failed to load Azure DevOps work items');
    }

    if (jiraResult.status === 'fulfilled') {
      merged = [...merged, ...jiraResult.value.items];
      setIsMockJira(jiraResult.value.isMock);
    } else {
      console.warn('[useMyWorkItems] Jira error:', jiraResult.reason?.message);
      setJiraError(jiraResult.reason?.message ?? 'Failed to load Jira issues');
    }

    // Sort: active items first, then by updatedAt descending
    merged.sort((a, b) => {
      const statusOrder = (s: string) => {
        const l = s.toLowerCase();
        if (l.includes('active') || l.includes('in progress')) return 0;
        if (l.includes('new') || l.includes('open') || l.includes('to do')) return 1;
        if (l.includes('resolved')) return 2;
        if (l.includes('done') || l.includes('closed')) return 3;
        return 4;
      };

      const orderDiff = statusOrder(a.status) - statusOrder(b.status);
      if (orderDiff !== 0) return orderDiff;

      // Fallback: newest updated first
      if (a.updatedAt && b.updatedAt) {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      return 0;
    });

    setItems(merged);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return { items, azdoError, jiraError, isMockJira, isLoading, refetch: fetchAll };
}
