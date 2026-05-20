import { BaseService } from '../../core/BaseService.js';
import * as JiraModel from './model.js';
import { JiraRepository } from './repository.js';
import { JiraController } from './controller.js';
import * as jiraRoutes from './routes.js';

/**
 * Jira Service
 * Provides Jira issue management via MCP tools and REST API.
 * Connects to on-prem Jira via Basic Auth (email + API token).
 * Falls back to mock data when JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN are not set,
 * or when USE_MOCK_JIRA=true.
 */
export class JiraService extends BaseService {
  readonly name = 'jira';
  readonly model = JiraModel;
  readonly repository: JiraRepository;
  readonly controller: JiraController;
  readonly routes = jiraRoutes;

  constructor() {
    super();
    this.repository = new JiraRepository();
    this.controller = new JiraController(this.repository);
  }

  async init(): Promise<void> {
    // Expose service globally so tools can access it (same pattern as kubectl)
    globalThis.__jiraService = this;
    console.log('[JiraService] Service initialized — tools registered, routes active');
  }

  registerRoutes(): void {
    console.log('[JiraService] Registering routes for jira service');
  }
}

export default JiraService;
