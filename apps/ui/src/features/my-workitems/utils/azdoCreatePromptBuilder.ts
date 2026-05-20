import type { CreateWorkItemData } from '../types';

/**
 * Build a prompt for Agent to review and improve the current work item draft
 * @param currentData - Current form state (partial)
 * @returns Formatted prompt for injection into Agent chat
 */
export function buildReviewRequestPrompt(currentData: Partial<CreateWorkItemData>): string {
  const title = currentData.title || '(empty)';
  const type = currentData.type || '(not selected)';
  const description = currentData.description || '(empty)';
  const priority = currentData.priority ? `${currentData.priority}` : '(not set)';
  const assignedTo = currentData.assignedTo || '(not assigned)';
  const tags = currentData.tags || '(none)';
  const acceptanceCriteria = currentData.acceptanceCriteria || '(not specified)';
  
  return `Please review and help improve this Azure DevOps work item draft:

**Title**: ${title}
**Type**: ${type}
**Priority**: ${priority}
**Assigned To**: ${assignedTo}
**Tags**: ${tags}

**Description**:
${description}

**Acceptance Criteria**:
${acceptanceCriteria}

Please analyze this draft and:
1. Improve the title for clarity and specificity
2. Enhance the description with more context if needed
3. Suggest appropriate priority based on severity/impact
4. Recommend relevant tags for categorization
5. Add or refine acceptance criteria

When ready, send the improved version back to update my form using the azdo_create_workitem tool.`;
}
