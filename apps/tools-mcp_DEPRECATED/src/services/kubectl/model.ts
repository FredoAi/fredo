/**
 * Kubectl Service Models
 * TypeScript interfaces for kubectl operations
 */

import type * as k8s from '@kubernetes/client-node';

// ============================================================================
// Common Types
// ============================================================================

export interface KubectlError {
  message: string;
  code: string;
  statusCode?: number;
  details?: any;
  kubernetesError?: any;
}

export interface ResourceFilter {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
}

// ============================================================================
// Pod Operations
// ============================================================================

export interface GetPodsRequest extends ResourceFilter {
  allNamespaces?: boolean;
}

export interface GetPodsResponse {
  success: boolean;
  pods?: k8s.V1Pod[];
  count?: number;
  error?: KubectlError;
}

export interface DescribePodRequest {
  namespace: string;
  name: string;
}

export interface DescribePodResponse {
  success: boolean;
  pod?: k8s.V1Pod;
  events?: k8s.CoreV1Event[];
  error?: KubectlError;
}

export interface DeletePodRequest {
  namespace: string;
  name: string;
  gracePeriodSeconds?: number;
}

export interface DeletePodResponse {
  success: boolean;
  message?: string;
  error?: KubectlError;
}

export interface GetLogsRequest {
  namespace: string;
  name: string;
  container?: string;
  previous?: boolean;
  tailLines?: number;
  timestamps?: boolean;
  sinceSeconds?: number;
}

export interface GetLogsResponse {
  success: boolean;
  logs?: string;
  error?: KubectlError;
}

// ============================================================================
// Deployment Operations
// ============================================================================

export interface GetDeploymentsRequest extends ResourceFilter {
  allNamespaces?: boolean;
}

export interface GetDeploymentsResponse {
  success: boolean;
  deployments?: k8s.V1Deployment[];
  count?: number;
  error?: KubectlError;
}

export interface ScaleDeploymentRequest {
  namespace: string;
  name: string;
  replicas: number;
}

export interface ScaleDeploymentResponse {
  success: boolean;
  currentReplicas?: number;
  desiredReplicas?: number;
  message?: string;
  error?: KubectlError;
}

export interface RestartDeploymentRequest {
  namespace: string;
  name: string;
}

export interface RestartDeploymentResponse {
  success: boolean;
  message?: string;
  restartedAt?: string;
  error?: KubectlError;
}

export interface RolloutStatusRequest {
  namespace: string;
  name: string;
  resourceType?: 'deployment' | 'statefulset' | 'daemonset';
}

export interface RolloutStatusResponse {
  success: boolean;
  status?: string;
  replicas?: {
    desired: number;
    current: number;
    updated: number;
    available: number;
    unavailable: number;
  };
  conditions?: k8s.V1DeploymentCondition[];
  error?: KubectlError;
}

// ============================================================================
// Service Operations
// ============================================================================

export interface GetServicesRequest extends ResourceFilter {
  allNamespaces?: boolean;
}

export interface GetServicesResponse {
  success: boolean;
  services?: k8s.V1Service[];
  count?: number;
  error?: KubectlError;
}

// ============================================================================
// Event Operations
// ============================================================================

export interface GetEventsRequest extends ResourceFilter {
  allNamespaces?: boolean;
  involvedObjectName?: string;
  involvedObjectKind?: string;
  eventType?: 'Normal' | 'Warning';
}

export interface GetEventsResponse {
  success: boolean;
  events?: k8s.CoreV1Event[];
  count?: number;
  error?: KubectlError;
}

// ============================================================================
// Resource Metrics Operations
// ============================================================================

export interface TopPodsRequest {
  namespace?: string;
  allNamespaces?: boolean;
  labelSelector?: string;
}

export interface PodMetrics {
  namespace: string;
  name: string;
  cpu: string;
  memory: string;
  containers: Array<{
    name: string;
    cpu: string;
    memory: string;
  }>;
}

export interface TopPodsResponse {
  success: boolean;
  metrics?: PodMetrics[];
  error?: KubectlError;
}

// ============================================================================
// Exec Operations
// ============================================================================

export interface ExecRequest {
  namespace: string;
  pod: string;
  container?: string;
  command: string[];
  stdin?: string;
  tty?: boolean;
}

export interface ExecResponse {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: KubectlError;
}
