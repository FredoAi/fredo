// ============================================================================
// Optimizely Service - Data Models & Interfaces
// ============================================================================

export type FlagEnvironment = 'production' | 'staging' | 'development';
export type FlagStatus = 'enabled' | 'disabled';

export interface OptimizelyFlag {
  id: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  environment: FlagEnvironment;
  rolloutPercentage: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Request / Response pairs ─────────────────────────────────────────────────

export interface GetFlagsRequest {
  environment?: FlagEnvironment;
  statusFilter?: FlagStatus | 'all';
}

export interface GetFlagsResponse {
  success: boolean;
  flags: OptimizelyFlag[];
  total: number;
  isMockData: boolean;
}

export interface UpdateFlagRequest {
  flagKey: string;
  enabled: boolean;
  environment?: FlagEnvironment;
  rolloutPercentage?: number;
}

export interface UpdateFlagResponse {
  success: boolean;
  flag?: OptimizelyFlag;
  isMockData: boolean;
  error?: string;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface OptimizelyConfig {
  sdkKey: string;
  projectId: string;
  baseUrl: string;
  useMock: boolean;
}

export function loadOptimizelyConfig(): OptimizelyConfig {
  const sdkKey = process.env.OPTIMIZELY_SDK_KEY || '';
  const projectId = process.env.OPTIMIZELY_PROJECT_ID || '';
  // Feature Experimentation Flags API — different from the old /v2 Management API
  const baseUrl = process.env.OPTIMIZELY_BASE_URL || 'https://api.optimizely.com/flags/v1';

  if (!sdkKey || !projectId) {
    return { sdkKey: '', projectId, baseUrl, useMock: true };
  }

  return { sdkKey, projectId, baseUrl, useMock: false };
}

// ── Mock Data ─────────────────────────────────────────────────────────────────

export const MOCK_FLAGS: OptimizelyFlag[] = [
  {
    id: 'flag-001',
    key: 'new_dashboard_ui',
    name: 'New Dashboard UI',
    description: 'Enables the redesigned dashboard with improved metrics visualization.',
    enabled: true,
    environment: 'production',
    rolloutPercentage: 100,
    tags: ['ui', 'dashboard'],
    createdAt: '2026-01-10T08:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
  },
  {
    id: 'flag-002',
    key: 'ai_copilot_suggestions',
    name: 'AI Copilot Suggestions',
    description: 'Shows AI-powered suggestions inline while browsing work items.',
    enabled: true,
    environment: 'production',
    rolloutPercentage: 50,
    tags: ['ai', 'productivity'],
    createdAt: '2026-01-20T10:00:00.000Z',
    updatedAt: '2026-02-15T09:30:00.000Z',
  },
  {
    id: 'flag-003',
    key: 'k8s_realtime_metrics',
    name: 'K8s Real-Time Metrics',
    description: 'Streams live Kubernetes cluster metrics into the diagram view.',
    enabled: false,
    environment: 'production',
    rolloutPercentage: 0,
    tags: ['kubernetes', 'infra', 'metrics'],
    createdAt: '2026-02-01T14:00:00.000Z',
    updatedAt: '2026-02-20T16:45:00.000Z',
  },
  {
    id: 'flag-004',
    key: 'dark_mode_v2',
    name: 'Dark Mode v2',
    description: 'Updated dark mode theme with higher contrast and new accent colors.',
    enabled: true,
    environment: 'staging',
    rolloutPercentage: 80,
    tags: ['ui', 'theme'],
    createdAt: '2026-02-10T11:00:00.000Z',
    updatedAt: '2026-03-05T08:00:00.000Z',
  },
  {
    id: 'flag-005',
    key: 'beta_query_builder',
    name: 'Beta Query Builder',
    description: 'Visual drag-and-drop query builder for logs and metrics.',
    enabled: false,
    environment: 'development',
    rolloutPercentage: 0,
    tags: ['beta', 'queries'],
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-10T11:00:00.000Z',
  },
  {
    id: 'flag-006',
    key: 'multi_cluster_support',
    name: 'Multi-Cluster Support',
    description: 'Allow switching between multiple Kubernetes clusters from the sidebar.',
    enabled: true,
    environment: 'staging',
    rolloutPercentage: 25,
    tags: ['kubernetes', 'enterprise'],
    createdAt: '2026-02-25T13:00:00.000Z',
    updatedAt: '2026-03-12T10:00:00.000Z',
  },
];
