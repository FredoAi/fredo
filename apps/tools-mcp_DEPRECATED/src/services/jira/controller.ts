import { JiraRepository } from './repository.js';
import type {
  GetMyIssuesRequest,
  GetMyIssuesResponse,
  GetIssueDetailsRequest,
  GetIssueDetailsResponse,
  CreateIssueRequest,
  CreateIssueResponse,
} from './model.js';

/**
 * Jira Controller
 * Business logic layer for Jira operations.
 */
export class JiraController {
  constructor(private repository: JiraRepository) {}

  // ============================================================================
  // Issue Operations
  // ============================================================================

  async getCurrentUserIssues(request: GetMyIssuesRequest): Promise<GetMyIssuesResponse> {
    const maxResults = Math.min(request.maxResults ?? 50, 100);
    return await this.repository.getCurrentUserIssues({ ...request, maxResults });
  }

  async getIssueDetails(request: GetIssueDetailsRequest): Promise<GetIssueDetailsResponse> {
    const key = request.issueKey?.trim().toUpperCase();

    if (!key) {
      return { success: false, issue: null, isMockData: false, error: 'issueKey is required' };
    }

    // Basic Jira key format validation: PROJECT-NUMBER (e.g. BUG-101, DEVOPS-205)
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
      return {
        success: false,
        issue: null,
        isMockData: false,
        error: `Invalid issue key format: "${key}". Expected format: PROJECT-NUMBER (e.g. BUG-101)`,
      };
    }

    return await this.repository.getIssueDetails({ issueKey: key });
  }

  async createIssue(request: CreateIssueRequest): Promise<CreateIssueResponse> {
    // Validate required fields
    if (!request.projectKey?.trim()) {
      return { success: false, isMockData: false, error: 'projectKey is required' };
    }
    if (!request.summary?.trim()) {
      return { success: false, isMockData: false, error: 'summary is required' };
    }
    if (!request.issueType) {
      return { success: false, isMockData: false, error: 'issueType is required. Valid values: Bug, Task, Story' };
    }

    const validTypes = ['Bug', 'Task', 'Story'];
    if (!validTypes.includes(request.issueType)) {
      return {
        success: false,
        isMockData: false,
        error: `Invalid issueType: "${request.issueType}". Valid values: ${validTypes.join(', ')}`,
      };
    }

    if (request.priority) {
      const validPriorities = ['Critical', 'High', 'Medium', 'Low'];
      if (!validPriorities.includes(request.priority)) {
        return {
          success: false,
          isMockData: false,
          error: `Invalid priority: "${request.priority}". Valid values: ${validPriorities.join(', ')}`,
        };
      }
    }

    return await this.repository.createIssue({
      ...request,
      projectKey: request.projectKey.trim().toUpperCase(),
      summary: request.summary.trim(),
    });
  }
}
