import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetMyIssuesRequest } from '../../model.js';

/**
 * Jira Get My Issues Tool
 * Fetches all Jira issues assigned to the current user with optional status filtering.
 */
export class JiraGetMyIssuesTool extends BaseTool {
  readonly name = 'jira_get_my_issues';
  readonly description =
    'Get all Jira issues/work items assigned to the current user. ' +
    'Optional: statusFilter (Open, In Progress, Done, All). ' +
    'Returns list of issues with key, summary, type, status, priority, labels, assignee, and dates. ' +
    'Returns mock data when Jira credentials are not configured. ' +
    'Use jira_get_issue_details to get full details for a specific issue key.';

  readonly exposedAs = 'both' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      statusFilter: {
        type: 'string',
        enum: ['Open', 'In Progress', 'Done', 'To Do', 'Closed', 'All'],
        description: 'Filter issues by status. Omit or use "All" to return all statuses.',
      },
      maxResults: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Maximum number of issues to return (default: 50)',
      },
    },
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get all my issues',
      description: 'Fetch all issues currently assigned to me',
      input: {},
    },
    {
      title: 'Get my open issues',
      description: 'Fetch only issues with status Open',
      input: { statusFilter: 'Open' },
    },
    {
      title: 'Get my in-progress issues (limited)',
      description: 'Fetch at most 10 in-progress issues',
      input: { statusFilter: 'In Progress', maxResults: 10 },
    },
  ];

  async execute(input: GetMyIssuesRequest, context?: any): Promise<any> {
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `jira_get_my_issues_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      const service = globalThis.__jiraService;
      if (!service) {
        throw new Error('[JiraGetMyIssuesTool] Jira service not initialized');
      }

      const result = await service.controller.getCurrentUserIssues(input);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
