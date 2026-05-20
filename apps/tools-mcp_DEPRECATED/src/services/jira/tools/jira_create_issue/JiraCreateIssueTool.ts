import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { CreateIssueRequest } from '../../model.js';

/**
 * Jira Create Issue Tool
 * Creates a new Jira issue in a specified project.
 */
export class JiraCreateIssueTool extends BaseTool {
  readonly name = 'jira_create_issue';
  readonly description =
    'Create a new Jira issue (Bug, Task, or Story) in a specified project. ' +
    'Requires: projectKey (e.g. BUG, DEVOPS), summary (title), issueType (Bug | Task | Story). ' +
    'Optional: description, priority (Critical | High | Medium | Low), labels (array of strings). ' +
    'Returns the created issue with its generated key (e.g. DEVOPS-512). ' +
    'Creates a simulated issue with a random key when Jira credentials are not configured.';

  readonly exposedAs = 'both' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputSchema = {
    type: 'object' as const,
    required: ['projectKey', 'summary', 'issueType'],
    properties: {
      projectKey: {
        type: 'string',
        description: 'Jira project key where the issue will be created (e.g. BUG, DEVOPS, PROJ)',
      },
      summary: {
        type: 'string',
        description: 'Issue title / one-line summary',
      },
      issueType: {
        type: 'string',
        enum: ['Bug', 'Task', 'Story'],
        description: 'Type of the issue to create',
      },
      description: {
        type: 'string',
        description: 'Detailed description of the issue (optional)',
      },
      priority: {
        type: 'string',
        enum: ['Critical', 'High', 'Medium', 'Low'],
        description: 'Issue priority (default: Medium)',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels to attach to the issue (optional)',
      },
    },
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Create a bug report',
      description: 'Report a critical production bug',
      input: {
        projectKey: 'BUG',
        summary: 'Login page crashes on Safari 17',
        issueType: 'Bug',
        priority: 'High',
        labels: ['safari', 'login', 'frontend'],
      },
    },
    {
      title: 'Create a task',
      description: 'Create a routine maintenance task',
      input: {
        projectKey: 'DEVOPS',
        summary: 'Rotate database credentials for staging environment',
        issueType: 'Task',
        description: 'Rotate all PostgreSQL credentials in the staging environment and update secrets in Vault.',
        priority: 'Medium',
      },
    },
    {
      title: 'Create a user story',
      description: 'Add a feature story to the project backlog',
      input: {
        projectKey: 'PROJ',
        summary: 'As a user, I want to export my data as CSV',
        issueType: 'Story',
        description: 'Provide a CSV export option in the user account settings page.',
        priority: 'Low',
        labels: ['export', 'data', 'ux'],
      },
    },
  ];

  async execute(input: CreateIssueRequest, context?: any): Promise<any> {
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `jira_create_issue_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      const service = globalThis.__jiraService;
      if (!service) {
        throw new Error('[JiraCreateIssueTool] Jira service not initialized');
      }

      const result = await service.controller.createIssue(input);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
