/**
 * Query Viewer Feature Constants
 */

import { API_BASE_URL } from '../../shared/constants/api';

/**
 * Query API endpoints for logs, metrics, and traces
 */
export const QUERY_ENDPOINTS = {
  LOGS: `${API_BASE_URL}/api/v1/logs-query/query`,
  METRICS: `${API_BASE_URL}/api/v1/metrics-query/query`,
  TRACES: `${API_BASE_URL}/api/v1/traces-query/query`,
} as const;
