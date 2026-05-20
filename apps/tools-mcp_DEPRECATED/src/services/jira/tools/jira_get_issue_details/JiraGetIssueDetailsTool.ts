import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetIssueDetailsRequest } from '../../model.js';

/**
 * Jira Get Issue Details Tool
 * Fetches full details for a specific Jira issue by its key.
 */
export class JiraGetIssueDetailsTool extends BaseTool {
  readonly name = 'jira_get_issue_details';
  readonly description =
    'Get full details for a specific Jira issue by its key (e.g. BUG-101, DEVOPS-205). ' +
    'Requires: issueKey (string in PROJECT-NUMBER format). ' +
    'Returns complete issue data including description, status, priority, assignee, labels, and timestamps. ' +
    'Use jira_get_my_issues first to discover available issue keys. ' +
    'Returns mock data when Jira credentials are not configured.';

  readonly exposedAs = 'both' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputSchema = {
    type: 'object' as const,
    required: ['issueKey'],
    properties: {
      issueKey: {
        type: 'string',
        description: 'Jira issue key in PROJECT-NUMBER format (e.g. BUG-101, DEVOPS-205, PROJ-318)',
      },
    },
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get bug details',
      description: 'Fetch full details for a bug report',
      input: { issueKey: 'BUG-101' },
    },
    {
      title: 'Get task details',
      description: 'Fetch details for a DevOps task',
      input: { issueKey: 'DEVOPS-205' },
    },
  ];

  async execute(input: GetIssueDetailsRequest, context?: any): Promise<any> {
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `jira_get_issue_details_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      const service = globalThis.__jiraService;
      if (!service) {
        throw new Error('[JiraGetIssueDetailsTool] Jira service not initialized');
      }

      const result = await service.controller.getIssueDetails(input);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
