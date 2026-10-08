import type { CreateIssueData } from '../types';

/**
 * Build a prompt asking Agent to review the Jira issue draft.
 */
export function buildReviewPrompt(data: Partial<CreateIssueData>): string {
  const lines: string[] = [
    `Please review this Jira issue draft and suggest improvements:`,
    ``,
    `**Project**: ${data.projectKey || '(not set)'}`,
    `**Type**: ${data.issueType || '(not set)'}`,
    `**Priority**: ${data.priority || 'Medium'}`,
    `**Summary**: ${data.summary || '(not set)'}`,
  ];

  if (data.description) {
    lines.push(``, `**Description**:`, data.description);
  }

  if (data.labels?.length) {
    lines.push(``, `**Labels**: ${data.labels.join(', ')}`);
  }

  lines.push(
    ``,
    `Please check for:`,
    `1. Clear and actionable summary`,
    `2. Appropriate issue type and priority`,
    `3. Sufficient description detail`,
    `4. Suggested labels if missing`,
  );

  return lines.join('\n');
}
