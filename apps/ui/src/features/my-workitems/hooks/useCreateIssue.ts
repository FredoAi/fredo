import { useState } from 'react';
import { API_BASE_URL } from '../../../shared/constants/api';
import type { CreateIssueData, JiraIssueCreated } from '../types';

interface UseCreateIssueReturn {
  create: (data: CreateIssueData) => Promise<JiraIssueCreated>;
  isLoading: boolean;
  error: string | null;
}

export function useCreateIssue(): UseCreateIssueReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (data: CreateIssueData): Promise<JiraIssueCreated> => {
    setIsLoading(true);
    setError(null);

    try {
      console.log('[useCreateIssue] Creating Jira issue:', data);

      const response = await fetch(`${API_BASE_URL}/api/v1/jira/issues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to create issue (${response.status}): ${errText}`);
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Unknown error creating issue');
      }

      const issue = result.issue;
      const created: JiraIssueCreated = {
        key: issue.key,
        url: issue.url,
        summary: issue.summary,
        issueType: issue.issueType,
        isMockData: result.isMockData,
      };

      console.log('[useCreateIssue] Issue created:', created.key);

      return created;
    } catch (err: any) {
      console.error('[useCreateIssue] Error:', err);
      setError(err.message || 'Failed to create Jira issue');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return { create, isLoading, error };
}
