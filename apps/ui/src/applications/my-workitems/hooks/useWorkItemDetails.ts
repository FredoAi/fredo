/**
 * Hook to fetch detailed information for a specific work item
 */

import { useState, useEffect } from 'react';
import { getWorkItemDetails, type AzdoWorkItemDetails } from '../../../shared/utils/azdoApi';
import { getPAT, getOrg, getProject } from '../../../shared/utils/patStorage';

interface UseWorkItemDetailsReturn {
  workItem: AzdoWorkItemDetails | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch detailed information for a specific work item
 * 
 * @param workItemId - ID of the work item to fetch
 * @returns Work item data, loading state, error, and refetch function
 */
export function useWorkItemDetails(workItemId: number | null | undefined): UseWorkItemDetailsReturn {
  const [workItem, setWorkItem] = useState<AzdoWorkItemDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkItemDetails = async () => {
    if (!workItemId) {
      setWorkItem(null);
      setError('No work item ID provided');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Get credentials from storage
      const org = getOrg();
      const project = getProject();
      const pat = getPAT();

      if (!org || !project || !pat) {
        throw new Error('Azure DevOps configuration not found. Please configure your credentials in Profile Settings.');
      }

      console.log('[useWorkItemDetails] Fetching work item details...');
      console.log('[useWorkItemDetails] Org:', org);
      console.log('[useWorkItemDetails] Project:', project);
      console.log('[useWorkItemDetails] Work Item ID:', workItemId);

      const details = await getWorkItemDetails(org, pat, project, workItemId);
      
      console.log('[useWorkItemDetails] Work item details fetched:', details.fields['System.Title']);
      setWorkItem(details);
    } catch (err: any) {
      console.error('[useWorkItemDetails] Error fetching work item details:', err);
      setError(err.message || 'Failed to fetch work item details');
      setWorkItem(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch when work item ID changes
  useEffect(() => {
    if (workItemId) {
      fetchWorkItemDetails();
    } else {
      setWorkItem(null);
      setError(null);
    }
  }, [workItemId]);

  return {
    workItem,
    isLoading,
    error,
    refetch: fetchWorkItemDetails,
  };
}
