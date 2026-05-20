import { useState } from 'react';
import { createWorkItem, type CreateWorkItemInput } from '../../../shared/utils/azdoApi';
import { getOrg, getProject, getPAT } from '../../../shared/utils/patStorage';

interface UseCreateWorkItemReturn {
  create: (data: CreateWorkItemInput) => Promise<{ workItemId: number; workItemUrl: string }>;
  isLoading: boolean;
  error: string | null;
}

export function useCreateWorkItem(): UseCreateWorkItemReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const create = async (workItemData: CreateWorkItemInput) => {
    setIsLoading(true);
    setError(null);
    
    try {
      // Get credentials from storage
      const org = getOrg();
      const project = getProject();
      const pat = getPAT();
      
      if (!org || !project || !pat) {
        throw new Error('Azure DevOps configuration not found. Please configure in Profile Settings.');
      }
      
      console.log('[useCreateWorkItem] Creating work item...');
      console.log('[useCreateWorkItem] Org:', org);
      console.log('[useCreateWorkItem] Project:', project);
      console.log('[useCreateWorkItem] Title:', workItemData.title);
      
      // Create work item via Azure DevOps API
      const createdWorkItem = await createWorkItem(org, pat, project, workItemData);
      const workItemId = createdWorkItem.id || createdWorkItem.fields['System.Id'];
      const workItemUrl = `https://dev.azure.com/${org}/_workitems/edit/${workItemId}`;
      
      console.log('[useCreateWorkItem] Work item created:', workItemId);
      return { workItemId, workItemUrl };
    } catch (err: any) {
      console.error('[useCreateWorkItem] Error:', err);
      setError(err.message || 'Failed to create work item');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };
  
  return { create, isLoading, error };
}
