import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

/**
 * Jira Service Routes
 * Exposes Jira operations via REST API at /api/v1/jira/*
 */
export class JiraRoutes extends BaseRoutes {
  protected serviceName = 'jira';
  protected serviceInstance: any;

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    const jiraService = options['jiraService'];
    this.serviceInstance = jiraService;

    // ──────────────────────────────────────────────────────────────────────────
    // GET /api/v1/jira/issues/my  — Current user's assigned issues
    // ──────────────────────────────────────────────────────────────────────────
    const myIssuesRoute = this.createRoute({
      method: 'GET',
      url: '/issues/my',
      schema: {
        description: 'Get all Jira issues assigned to the current user',
        tags: ['jira'],
        querystring: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['Open', 'In Progress', 'Done', 'To Do', 'Closed', 'All'],
              description: 'Filter by status (omit for all)',
            },
            maxResults: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Maximum number of issues to return (default: 50)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              issues: { type: 'array' },
              total: { type: 'integer' },
              isMockData: { type: 'boolean' },
            },
          },
        },
      },
      handler: async (request: any, reply) => {
        const result = await jiraService.controller.getCurrentUserIssues({
          statusFilter: request.query.status,
          maxResults: request.query.maxResults,
        });
        return reply.send(result);
      },
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /api/v1/jira/issues/:key  — Issue details
    // ──────────────────────────────────────────────────────────────────────────
    const issueDetailsRoute = this.createRoute({
      method: 'GET',
      url: '/issues/:key',
      schema: {
        description: 'Get details for a specific Jira issue by key (e.g. BUG-101)',
        tags: ['jira'],
        params: {
          type: 'object',
          required: ['key'],
          properties: {
            key: {
              type: 'string',
              description: 'Jira issue key (e.g. BUG-101, DEVOPS-205)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              issue: {},
              isMockData: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
      handler: async (request: any, reply) => {
        const result = await jiraService.controller.getIssueDetails({
          issueKey: request.params.key,
        });
        const statusCode = result.success ? 200 : 404;
        return reply.status(statusCode).send(result);
      },
    });

    // ──────────────────────────────────────────────────────────────────────────
    // POST /api/v1/jira/issues  — Create a new issue
    // ──────────────────────────────────────────────────────────────────────────
    const createIssueRoute = this.createRoute({
      method: 'POST',
      url: '/issues',
      schema: {
        description: 'Create a new Jira issue',
        tags: ['jira'],
        body: {
          type: 'object',
          required: ['projectKey', 'summary', 'issueType'],
          properties: {
            projectKey: { type: 'string', description: 'Jira project key (e.g. BUG, DEVOPS)' },
            summary: { type: 'string', description: 'Issue title/summary' },
            issueType: {
              type: 'string',
              enum: ['Bug', 'Task', 'Story'],
              description: 'Type of the issue',
            },
            description: { type: 'string', description: 'Detailed description of the issue' },
            priority: {
              type: 'string',
              enum: ['Critical', 'High', 'Medium', 'Low'],
              description: 'Issue priority',
            },
            labels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Labels to attach to the issue',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              issue: {},
              isMockData: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
      handler: async (request: any, reply) => {
        const result = await jiraService.controller.createIssue(request.body);
        const statusCode = result.success ? 200 : 400;
        return reply.status(statusCode).send(result);
      },
    });

    fastify.route(myIssuesRoute);
    fastify.route(issueDetailsRoute);
    fastify.route(createIssueRoute);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backwards-compatibility export (required by router)
// ─────────────────────────────────────────────────────────────────────────────
const jiraRoutesInstance = new JiraRoutes();

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  await jiraRoutesInstance.register(fastify, options);
}

export default jiraRoutesInstance;
