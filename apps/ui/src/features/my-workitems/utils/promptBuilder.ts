/**
 * Builds a context-rich prompt for Agent based on the selected work item,
 * regardless of whether it came from Azure DevOps or Jira.
 */

import type { AzdoWorkItemDetails } from '../../../shared/utils/azdoApi';
import type { JiraIssue } from '../types';

function stripHtml(html: string | undefined): string {
  if (!html) return 'Not specified';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildAzdoPrompt(workItem: AzdoWorkItemDetails): string {
  const f = workItem.fields;
  const id = f['System.Id'];
  const title = f['System.Title'];
  const type = f['System.WorkItemType'];
  const state = f['System.State'];
  const description = stripHtml(f['System.Description']);
  const criteria = stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria']);
  const assignedTo = f['System.AssignedTo']?.displayName || 'Unassigned';
  const tags = f['System.Tags'] || 'None';
  const areaPath = f['System.AreaPath'] || 'N/A';
  const iteration = f['System.IterationPath'] || 'N/A';

  return `Help me start working on Azure DevOps work item #${id}: ${title}

**Work Item Details:**
- **Type**: ${type}
- **State**: ${state}
- **Assigned To**: ${assignedTo}
- **Area Path**: ${areaPath}
- **Iteration**: ${iteration}
- **Tags**: ${tags}

**Description:**
${description}

**Acceptance Criteria:**
${criteria}

**What I need help with:**
1. What should I focus on first?
2. Are there any potential challenges or considerations?
3. Can you suggest an implementation approach or breakdown of tasks?

Please provide guidance on how to start working on this effectively.`;
}

export function buildJiraPrompt(issue: JiraIssue): string {
  return `Help me start working on Jira issue ${issue.key}: ${issue.summary}

**Issue Details:**
- **Type**: ${issue.issueType}
- **Status**: ${issue.status}
- **Priority**: ${issue.priority}
- **Project**: ${issue.projectName}
- **Labels**: ${issue.labels.length > 0 ? issue.labels.join(', ') : 'None'}
- **Reporter**: ${issue.reporter.displayName}

**Description:**
${issue.description || 'No description provided'}

**What I need help with:**
1. What should I focus on first?
2. Are there any potential challenges or considerations?
3. Can you suggest an implementation approach or breakdown of tasks?

Please provide guidance on how to start working on this effectively.`;
}
