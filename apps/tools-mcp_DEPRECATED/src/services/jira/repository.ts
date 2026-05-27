import type {
  JiraConfig,
  JiraIssue,
  JiraUser,
  JiraIssueType,
  JiraPriority,
  JiraStatus,
  GetMyIssuesRequest,
  GetMyIssuesResponse,
  GetIssueDetailsRequest,
  GetIssueDetailsResponse,
  CreateIssueRequest,
  CreateIssueResponse,
} from './model.js';
import { loadJiraConfig, MOCK_ISSUES } from './model.js';

/**
 * Jira Repository
 * Handles Jira REST API v3 calls with Basic Auth (email + API token).
 * Falls back to mock data when USE_MOCK_JIRA=true or credentials are not set.
 */
export class JiraRepository {
  private config: JiraConfig;
  private authHeader: string;

  constructor() {
    this.config = loadJiraConfig();

    // Pre-compute Basic Auth header: base64(email:apiToken)
    const credentials = `${this.config.email}:${this.config.apiToken}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString('base64')}`;

    const mode = this.config.useMock ? '🎭 MOCK' : '🔗 LIVE';
    console.log(`[JiraRepository] Initialized — Mode: ${mode}`);
    if (!this.config.useMock) {
      console.log(`[JiraRepository] Connecting to: ${this.config.baseUrl}`);
    }
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  async getCurrentUserIssues(request: GetMyIssuesRequest): Promise<GetMyIssuesResponse> {
    if (this.config.useMock) {
      return this.getMockCurrentUserIssues(request);
    }

    try {
      const statusClause =
        request.statusFilter && request.statusFilter !== 'All'
          ? ` AND status = "${request.statusFilter}"`
          : '';
      const jql = `assignee = currentUser()${statusClause} ORDER BY updated DESC`;
      const maxResults = request.maxResults ?? 50;

      const url = `${this.config.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,description,issuetype,status,priority,labels,assignee,reporter,project,created,updated`;

      const response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      const issues: JiraIssue[] = (data.issues ?? []).map((raw: any) =>
        this.mapRawIssue(raw)
      );

      return { success: true, issues, total: data.total ?? issues.length, isMockData: false };
    } catch (error: any) {
      console.error('[JiraRepository] Failed to fetch issues from Jira API:', error.message);
      throw error;
    }
  }

  async getIssueDetails(request: GetIssueDetailsRequest): Promise<GetIssueDetailsResponse> {
    if (this.config.useMock) {
      return this.getMockIssueDetails(request.issueKey);
    }

    try {
      const url = `${this.config.baseUrl}/rest/api/3/issue/${encodeURIComponent(request.issueKey)}?fields=summary,description,issuetype,status,priority,labels,assignee,reporter,project,created,updated`;

      const response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });

      if (response.status === 404) {
        return { success: false, issue: null, isMockData: false, error: `Issue not found: ${request.issueKey}` };
      }

      if (!response.ok) {
        throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
      }

      const raw = (await response.json()) as any;
      const issue = this.mapRawIssue(raw);

      return { success: true, issue, isMockData: false };
    } catch (error: any) {
      console.error(`[JiraRepository] Failed to fetch issue ${request.issueKey}:`, error.message);
      throw error;
    }
  }

  async createIssue(request: CreateIssueRequest): Promise<CreateIssueResponse> {
    if (this.config.useMock) {
      return this.createMockIssue(request);
    }

    try {
      const url = `${this.config.baseUrl}/rest/api/3/issue`;

      const body: any = {
        fields: {
          project: { key: request.projectKey },
          summary: request.summary,
          issuetype: { name: request.issueType },
          ...(request.description && {
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: request.description }],
                },
              ],
            },
          }),
          ...(request.priority && { priority: { name: request.priority } }),
          ...(request.labels?.length && { labels: request.labels }),
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Jira API error ${response.status}: ${errBody}`);
      }

      const created = (await response.json()) as any;

      // Fetch full issue details after creation
      const detailsResponse = await this.getIssueDetails({ issueKey: created.key });
      if (detailsResponse.success && detailsResponse.issue) {
        return { success: true, issue: detailsResponse.issue, isMockData: false };
      }

      // Return minimal data if fetch fails
      const minimalIssue: JiraIssue = {
        id: created.id,
        key: created.key,
        summary: request.summary,
        description: request.description ?? '',
        issueType: request.issueType,
        status: 'Open',
        priority: request.priority ?? 'Medium',
        labels: request.labels ?? [],
        assignee: null,
        reporter: { accountId: '', displayName: 'Unknown', emailAddress: '' },
        projectKey: request.projectKey,
        projectName: request.projectKey,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        url: `${this.config.baseUrl}/browse/${created.key}`,
      };

      return { success: true, issue: minimalIssue, isMockData: false };
    } catch (error: any) {
      console.error('[JiraRepository] Failed to create issue:', error.message);
      throw error;
    }
  }

  // ============================================================================
  // Mock Implementations
  // ============================================================================

  private getMockCurrentUserIssues(request: GetMyIssuesRequest): GetMyIssuesResponse {
    let issues = [...MOCK_ISSUES];

    if (request.statusFilter && request.statusFilter !== 'All') {
      issues = issues.filter((i) => i.status === request.statusFilter);
    }

    if (request.maxResults) {
      issues = issues.slice(0, request.maxResults);
    }

    return { success: true, issues, total: issues.length, isMockData: true };
  }

  private getMockIssueDetails(issueKey: string): GetIssueDetailsResponse {
    const issue = MOCK_ISSUES.find((i) => i.key.toLowerCase() === issueKey.toLowerCase()) ?? null;

    if (!issue) {
      return {
        success: false,
        issue: null,
        isMockData: true,
        error: `Issue '${issueKey}' not found. Available mock keys: ${MOCK_ISSUES.map((i) => i.key).join(', ')}`,
      };
    }

    return { success: true, issue, isMockData: true };
  }

  private createMockIssue(request: CreateIssueRequest): CreateIssueResponse {
    const id = (10600 + Math.floor(Math.random() * 400)).toString();
    const issueNumber = Math.floor(Math.random() * 900) + 100;
    const key = `${request.projectKey}-${issueNumber}`;

    const newIssue: JiraIssue = {
      id,
      key,
      summary: request.summary,
      description: request.description ?? '',
      issueType: request.issueType,
      status: 'Open',
      priority: request.priority ?? 'Medium',
      labels: request.labels ?? [],
      assignee: null,
      reporter: {
        accountId: 'user-001',
        displayName: 'Francisco Torres',
        emailAddress: 'francisco@company.com',
      },
      projectKey: request.projectKey,
      projectName: request.projectKey,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      url: `https://jira.company.com/browse/${key}`,
    };

    console.log(`[JiraRepository] 🎭 Mock issue created: ${key} — "${request.summary}"`);
    return { success: true, issue: newIssue, isMockData: true };
  }

  // ============================================================================
  // Jira API Response Mapper
  // ============================================================================

  private mapRawIssue(raw: any): JiraIssue {
    const fields = raw.fields ?? {};

    const assignee: JiraUser | null = fields.assignee
      ? {
          accountId: fields.assignee.accountId ?? '',
          displayName: fields.assignee.displayName ?? '',
          emailAddress: fields.assignee.emailAddress ?? '',
          avatarUrl: fields.assignee.avatarUrls?.['48x48'],
        }
      : null;

    const reporter: JiraUser = {
      accountId: fields.reporter?.accountId ?? '',
      displayName: fields.reporter?.displayName ?? 'Unknown',
      emailAddress: fields.reporter?.emailAddress ?? '',
      avatarUrl: fields.reporter?.avatarUrls?.['48x48'],
    };

    // Flatten Fredosian Document Format description to plain text
    const description = this.extractDescriptionText(fields.description);

    return {
      id: raw.id,
      key: raw.key,
      summary: fields.summary ?? '',
      description,
      issueType: (fields.issuetype?.name ?? 'Task') as JiraIssueType,
      status: (fields.status?.name ?? 'Open') as JiraStatus,
      priority: (fields.priority?.name ?? 'Medium') as JiraPriority,
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      assignee,
      reporter,
      projectKey: fields.project?.key ?? '',
      projectName: fields.project?.name ?? '',
      created: fields.created ?? new Date().toISOString(),
      updated: fields.updated ?? new Date().toISOString(),
      url: `${this.config.baseUrl}/browse/${raw.key}`,
    };
  }

  /** Extract plain text from Fredosian Document Format (ADF) or plain string */
  private extractDescriptionText(description: any): string {
    if (!description) return '';
    if (typeof description === 'string') return description;

    // ADF format
    if (description.type === 'doc' && Array.isArray(description.content)) {
      return description.content
        .map((block: any) =>
          (block.content ?? [])
            .filter((node: any) => node.type === 'text')
            .map((node: any) => node.text ?? '')
            .join('')
        )
        .join('\n')
        .trim();
    }

    return '';
  }
}
