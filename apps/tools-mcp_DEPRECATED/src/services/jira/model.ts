// ============================================================================
// Jira Service - Data Models & Interfaces
// ============================================================================

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
  avatarUrl?: string;
}

export type JiraIssueType = 'Bug' | 'Task' | 'Story';
export type JiraStatus = 'Open' | 'In Progress' | 'Done' | 'To Do' | 'Closed';
export type JiraPriority = 'Critical' | 'High' | 'Medium' | 'Low';

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

export interface GetMyIssuesRequest {
  statusFilter?: JiraStatus | 'All';
  maxResults?: number;
}

export interface GetMyIssuesResponse {
  success: boolean;
  issues: JiraIssue[];
  total: number;
  isMockData: boolean;
}

export interface GetIssueDetailsRequest {
  issueKey: string;
}

export interface GetIssueDetailsResponse {
  success: boolean;
  issue: JiraIssue | null;
  isMockData: boolean;
  error?: string;
}

export interface CreateIssueRequest {
  projectKey: string;
  summary: string;
  issueType: JiraIssueType;
  description?: string;
  priority?: JiraPriority;
  labels?: string[];
}

export interface CreateIssueResponse {
  success: boolean;
  issue?: JiraIssue;
  isMockData: boolean;
  error?: string;
}

// ============================================================================
// Jira Configuration
// ============================================================================

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  useMock: boolean;
}

export function loadJiraConfig(): JiraConfig {
  const baseUrl = process.env.JIRA_BASE_URL ?? '';
  const email = process.env.JIRA_EMAIL ?? '';
  const apiToken = process.env.JIRA_API_TOKEN ?? '';

  // Use mock data if explicitly requested or if credentials are missing
  const credentialsMissing = !baseUrl || !email || !apiToken;
  const useMock = process.env.USE_MOCK_JIRA === 'true' || credentialsMissing;

  if (credentialsMissing && process.env.USE_MOCK_JIRA !== 'true') {
    console.warn(
      '[JiraModel] ⚠️  Jira credentials not configured. ' +
      'Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in .env to connect to your Jira instance. ' +
      'Falling back to mock data.'
    );
  }

  return { baseUrl, email, apiToken, useMock };
}

// ============================================================================
// Mock Data - 5 realistic issues for development/demo
// ============================================================================

const mockReporter: JiraUser = {
  accountId: 'user-001',
  displayName: 'Francisco Torres',
  emailAddress: 'francisco@company.com',
};

const mockAssignee1: JiraUser = {
  accountId: 'user-002',
  displayName: 'Agent',
  emailAddress: 'agent@company.com',
};

const mockAssignee2: JiraUser = {
  accountId: 'user-003',
  displayName: 'Daniel Reis',
  emailAddress: 'daniel@company.com',
};

export const MOCK_ISSUES: JiraIssue[] = [
  {
    id: '10101',
    key: 'BUG-101',
    summary: 'Authentication timeout during OAuth flow on mobile browsers',
    description:
      'Users on mobile browsers experience a 30-second timeout during the OAuth 2.0 flow ' +
      'when the network transitions between WiFi and cellular. Affects approximately 15% of ' +
      'mobile users. Steps to reproduce: 1) Open app on mobile, 2) Begin login, 3) Switch networks, ' +
      '4) Observe timeout error in console.',
    issueType: 'Bug',
    status: 'In Progress',
    priority: 'High',
    labels: ['authentication', 'mobile', 'oauth'],
    assignee: mockAssignee1,
    reporter: mockReporter,
    projectKey: 'BUG',
    projectName: 'Bug Tracker',
    created: '2026-02-10T09:15:00.000Z',
    updated: '2026-03-01T14:22:00.000Z',
    url: 'https://jira.company.com/browse/BUG-101',
  },
  {
    id: '10205',
    key: 'DEVOPS-205',
    summary: 'Set up CI/CD pipeline for tools-mcp service',
    description:
      'Configure GitHub Actions pipeline for automated build, test, and deployment ' +
      'of the tools-mcp Docker image. Should include: lint, unit tests, integration tests, ' +
      'Docker build, push to registry, and deploy to staging. Environment secrets must be ' +
      'configured in GitHub repository settings.',
    issueType: 'Task',
    status: 'Open',
    priority: 'Medium',
    labels: ['ci-cd', 'github-actions', 'devops', 'docker'],
    assignee: null,
    reporter: mockReporter,
    projectKey: 'DEVOPS',
    projectName: 'DevOps & Infrastructure',
    created: '2026-02-18T11:30:00.000Z',
    updated: '2026-02-18T11:30:00.000Z',
    url: 'https://jira.company.com/browse/DEVOPS-205',
  },
  {
    id: '10318',
    key: 'PROJ-318',
    summary: 'Implement user onboarding flow with guided walkthrough',
    description:
      'As a new user, I want to see an interactive guided walkthrough when I first open ' +
      'the Fredo extension, so that I understand how to connect my tools and start a session. ' +
      'Acceptance criteria: 1) Welcome screen on first install, 2) Step-by-step configuration guide, ' +
      '3) Demo mode with sample data, 4) Skip option available at each step.',
    issueType: 'Story',
    status: 'Done',
    priority: 'Low',
    labels: ['ux', 'onboarding', 'browser-extension'],
    assignee: mockAssignee2,
    reporter: mockReporter,
    projectKey: 'PROJ',
    projectName: 'Fredo Project',
    created: '2026-01-20T08:00:00.000Z',
    updated: '2026-02-28T16:45:00.000Z',
    url: 'https://jira.company.com/browse/PROJ-318',
  },
  {
    id: '10422',
    key: 'BUG-422',
    summary: 'Memory leak in reporting module causes OOM crash after 24h',
    description:
      'The reporting service crashes with OOM (out of memory) after approximately 24 hours ' +
      'of continuous operation. Analysis shows a memory leak in the PDF generation pipeline — ' +
      'Puppeteer instances are not being properly closed after rendering. ' +
      'Heap dumps confirm objects accumulate over time. Needs immediate fix for production stability.',
    issueType: 'Bug',
    status: 'Open',
    priority: 'Critical',
    labels: ['memory-leak', 'reporting', 'production', 'critical'],
    assignee: mockAssignee1,
    reporter: mockAssignee2,
    projectKey: 'BUG',
    projectName: 'Bug Tracker',
    created: '2026-03-01T07:45:00.000Z',
    updated: '2026-03-04T18:10:00.000Z',
    url: 'https://jira.company.com/browse/BUG-422',
  },
  {
    id: '10511',
    key: 'DEVOPS-511',
    summary: 'Update all npm dependencies to latest stable versions',
    description:
      'Conduct a full dependency audit across all workspace packages using `pnpm audit`. ' +
      'Update all packages to their latest stable versions, resolve any breaking changes, ' +
      'and run the full test suite to verify compatibility. Priority packages: react, ' +
      'chakra-ui, fastify, typescript. Document any breaking changes in CHANGELOG.',
    issueType: 'Task',
    status: 'In Progress',
    priority: 'Low',
    labels: ['dependencies', 'maintenance', 'npm'],
    assignee: mockAssignee2,
    reporter: mockReporter,
    projectKey: 'DEVOPS',
    projectName: 'DevOps & Infrastructure',
    created: '2026-02-25T13:00:00.000Z',
    updated: '2026-03-03T10:30:00.000Z',
    url: 'https://jira.company.com/browse/DEVOPS-511',
  },
];
