import { useState, useEffect } from 'react';
import { API_BASE_URL } from '../../../shared/constants/api';
import type { JiraIssue } from '../types';

interface UseJiraIssueDetailsReturn {
  issue: JiraIssue | null;
  isMockData: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useJiraIssueDetails(issueKey: string | null): UseJiraIssueDetailsReturn {
  const [issue, setIssue] = useState<JiraIssue | null>(null);
  const [isMockData, setIsMockData] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!issueKey) {
      setIssue(null);
      return;
    }

    const fetch_ = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const url = `${API_BASE_URL}/api/v1/jira/issues/${encodeURIComponent(issueKey)}`;
        console.log('[useJiraIssueDetails] Fetching:', url);

        const response = await fetch(url, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        if (!data.success || !data.issue) {
          throw new Error(data.error || 'Issue not found');
        }

        setIssue(data.issue);
        setIsMockData(data.isMockData || false);
        console.log('[useJiraIssueDetails] Loaded:', data.issue.key);
      } catch (err: any) {
        console.error('[useJiraIssueDetails] Error:', err);
        setError(err.message || 'Failed to fetch issue details');
        setIssue(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetch_();
  }, [issueKey]);

  return { issue, isMockData, isLoading, error };
}
