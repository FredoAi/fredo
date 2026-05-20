/**
 * Unified Work Items types — covers both Azure DevOps and Jira items
 */

// ─── Source ──────────────────────────────────────────────────────────────────

export type WorkItemSource = 'azdo' | 'jira';
export type SourceFilter = 'all' | WorkItemSource;

// ─── Unified card shape ───────────────────────────────────────────────────────

export interface UnifiedWorkItem {
  /** Unique id within this source (AzDo numeric id as string, or Jira key like "BUG-42") */
  id: string;
  source: WorkItemSource;
  title: string;
  type: string;     // e.g. "Task" / "Bug" / "Story"
  status: string;   // raw status string from the source
  priority?: string | number;
  projectName?: string;
  url?: string;
  /** ISO date string */
  updatedAt?: string;
}

// ─── Detail view mode ─────────────────────────────────────────────────────────

export type DetailMode = 'list' | 'detail';

export interface DetailTarget {
  source: WorkItemSource;
  /** AzDo: numeric id (stored as number); Jira: issue key string */
  id: string;
}

// ─── Status filter ────────────────────────────────────────────────────────────

export type StatusFilter = 'All' | 'Active' | 'In Progress' | 'Open' | 'To Do' | 'Resolved' | 'Done' | 'Closed';

// ─── Jira domain types (self-contained, no dependency on jira-get-my-issues) ──

export type JiraIssueType = 'Bug' | 'Task' | 'Story';
export type JiraStatus = 'Open' | 'In Progress' | 'Done' | 'To Do' | 'Closed';
export type JiraPriority = 'Critical' | 'High' | 'Medium' | 'Low';

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string;
  issueType: JiraIssueType;
  status: JiraStatus;
  priority: JiraPriority;
  labels: string[];
  assignee: JiraUser | null;
  reporter: JiraUser;
  projectKey: string;
  projectName: string;
  created: string;
  updated: string;
  url: string;
}

// ─── Create Work Item (Azure DevOps) ─────────────────────────────────────────

export type WorkItemPlatform = 'azdo' | 'jira';

export interface CreateWorkItemData {
  title: string;
  type: 'Bug' | 'Task' | 'User Story' | 'Feature' | 'Epic';
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  assignedTo?: string;
  tags?: string;
  areaPath?: string;
  iterationPath?: string;
  acceptanceCriteria?: string;
}

export type CreateWorkItemMode = 'form' | 'success';

// ─── Create Issue (Jira) ──────────────────────────────────────────────────────

export interface CreateIssueData {
  projectKey: string;
  summary: string;
  issueType: JiraIssueType;
  description?: string;
  priority?: JiraPriority;
  labels?: string[];
}

export type CreateIssueMode = 'form' | 'success';

export interface JiraIssueCreated {
  key: string;
  url: string;
  summary: string;
  issueType: JiraIssueType;
  isMockData: boolean;
}
