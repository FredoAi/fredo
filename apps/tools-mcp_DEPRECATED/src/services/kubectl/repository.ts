import * as k8s from '@kubernetes/client-node';
import type {
  GetPodsRequest,
  GetPodsResponse,
  DescribePodRequest,
  DescribePodResponse,
  DeletePodRequest,
  DeletePodResponse,
  GetLogsRequest,
  GetLogsResponse,
  GetDeploymentsRequest,
  GetDeploymentsResponse,
  ScaleDeploymentRequest,
  ScaleDeploymentResponse,
  RestartDeploymentRequest,
  RestartDeploymentResponse,
  RolloutStatusRequest,
  RolloutStatusResponse,
  GetServicesRequest,
  GetServicesResponse,
  GetEventsRequest,
  GetEventsResponse,
  TopPodsRequest,
  TopPodsResponse,
  ExecRequest,
  ExecResponse,
  KubectlError,
} from './model.js';

/**
 * Kubectl Repository
 * Handles Kubernetes API operations using @kubernetes/client-node
 */
export class KubectlRepository {
  private kc: k8s.KubeConfig;
  private k8sApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private metricsApi: k8s.Metrics;
  private exec: k8s.Exec;

  constructor() {
    this.kc = new k8s.KubeConfig();
    this.loadKubeConfig();
    
    // Only create API clients if we have a valid cluster configuration
    try {
      this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.metricsApi = new k8s.Metrics(this.kc);
      this.exec = new k8s.Exec(this.kc);
      console.log('[KubectlRepository] ✅ Kubernetes API clients initialized');
    } catch (error) {
      console.log('[KubectlRepository] ⚠️  No active Kubernetes cluster - running in degraded mode');
      throw error; // kubectl service requires a cluster, so we re-throw
    }
  }

  private loadKubeConfig(): void {
    try {
      this.kc.loadFromDefault();
      
      // Patch for Docker environment (same as infrastructure-diagram)
      const cluster = this.kc.getCurrentCluster();
      const user = this.kc.getCurrentUser();
      
      if (cluster && cluster.server) {
        
        // Fix Windows paths in kubeconfig
        if (cluster.caFile && cluster.caFile.includes('C:\\Users\\')) {
          const minikubePart = cluster.caFile.match(/\.minikube[\\\/].*/);
          if (minikubePart) {
            const fixedPath = '/root/' + minikubePart[0].replace(/\\/g, '/');
            Object.assign(cluster, { caFile: fixedPath });
            console.log(`[KubectlRepository] Fixed CA file path: ${fixedPath}`);
          }
        }
        
        // For development with minikube self-signed certs
        Object.assign(cluster, { skipTLSVerify: true });
      }
      
      // Fix Windows paths for client certificates
      if (user) {
        if (user.certFile && user.certFile.includes('C:\\Users\\')) {
          const minikubePart = user.certFile.match(/\.minikube[\\\/].*/);
          if (minikubePart) {
            const fixedCertPath = '/root/' + minikubePart[0].replace(/\\/g, '/');
            Object.assign(user, { certFile: fixedCertPath });
          }
        }
        if (user.keyFile && user.keyFile.includes('C:\\Users\\')) {
          const minikubePart = user.keyFile.match(/\.minikube[\\\/].*/);
          if (minikubePart) {
            const fixedKeyPath = '/root/' + minikubePart[0].replace(/\\/g, '/');
            Object.assign(user, { keyFile: fixedKeyPath });
          }
        }
      }
      
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      console.log('[KubectlRepository] Loaded kubeconfig from default location');
    } catch (error) {
      console.error('[KubectlRepository] Could not load kubeconfig:', error);
      throw new Error('Failed to initialize Kubernetes client');
    }
  }

  private handleK8sError(error: any): KubectlError {
    return {
      message: error.message || 'Kubernetes API error',
      code: error.body?.code || error.statusCode?.toString() || 'K8S_ERROR',
      statusCode: error.statusCode,
      kubernetesError: error.body,
      details: error.body?.details,
    };
  }

  // ============================================================================
  // Pod Operations
  // ============================================================================

  async getPods(request: GetPodsRequest): Promise<GetPodsResponse> {
    try {
      const { namespace, labelSelector, fieldSelector, limit, allNamespaces } = request;
      
      let response;
      if (allNamespaces || !namespace) {
        const params: any = {};
        if (fieldSelector) params.fieldSelector = fieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.k8sApi.listPodForAllNamespaces(params);
      } else {
        const params: any = { namespace };
        if (fieldSelector) params.fieldSelector = fieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.k8sApi.listNamespacedPod(params);
      }
      
      return {
        success: true,
        pods: response.items,
        count: response.items.length,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  async describePod(request: DescribePodRequest): Promise<DescribePodResponse> {
    try {
      const { namespace, name } = request;
      
      const podResponse = await this.k8sApi.readNamespacedPod({ name, namespace });
      const eventsResponse = await this.k8sApi.listNamespacedEvent({
        namespace,
        fieldSelector: `involvedObject.name=${name},involvedObject.kind=Pod`
      });
      
      return {
        success: true,
        pod: podResponse,
        events: eventsResponse.items,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  async deletePod(request: DeletePodRequest): Promise<DeletePodResponse> {
    try {
      const { namespace, name, gracePeriodSeconds } = request;
      
      // For deleteNamespacedPod, gracePeriodSeconds goes in query params, not body
      const params: any = { name, namespace };
      
      // Only include gracePeriodSeconds if explicitly provided
      if (gracePeriodSeconds !== undefined && gracePeriodSeconds !== null) {
        params.gracePeriodSeconds = gracePeriodSeconds;
      }
      
      await this.k8sApi.deleteNamespacedPod(params);
      
      return {
        success: true,
        message: `Pod ${name} in namespace ${namespace} deleted successfully`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  async getLogs(request: GetLogsRequest): Promise<GetLogsResponse> {
    try {
      const { namespace, name, container, previous, tailLines, timestamps, sinceSeconds } = request;
      
      const params: any = { name, namespace };
      if (container) params.container = container;
      if (previous !== undefined) params.previous = previous;
      if (timestamps !== undefined) params.timestamps = timestamps;
      if (tailLines !== undefined && tailLines !== null) params.tailLines = tailLines;
      if (sinceSeconds !== undefined && sinceSeconds !== null) params.sinceSeconds = sinceSeconds;
      
      const logs = await this.k8sApi.readNamespacedPodLog(params);
      
      return {
        success: true,
        logs: logs,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  // ============================================================================
  // Deployment Operations
  // ============================================================================

  async getDeployments(request: GetDeploymentsRequest): Promise<GetDeploymentsResponse> {
    try {
      const { namespace, labelSelector, fieldSelector, limit, allNamespaces } = request;
      
      let response;
      if (allNamespaces || !namespace) {
        const params: any = {};
        if (fieldSelector) params.fieldSelector = fieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.appsApi.listDeploymentForAllNamespaces(params);
      } else {
        const params: any = { namespace };
        if (fieldSelector) params.fieldSelector = fieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.appsApi.listNamespacedDeployment(params);
      }
      
      return {
        success: true,
        deployments: response.items,
        count: response.items.length,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  async scaleDeployment(request: ScaleDeploymentRequest): Promise<ScaleDeploymentResponse> {
    try {
      const { namespace, name, replicas } = request;
      
      const patch = {
        spec: { replicas },
      };
      
      const response = await this.appsApi.patchNamespacedDeployment({
        name,
        namespace,
        body: patch
      });
      
      return {
        success: true,
        currentReplicas: response.status?.replicas || 0,
        desiredReplicas: response.spec?.replicas || replicas,
        message: `Deployment ${name} scaled to ${replicas} replicas`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  async restartDeployment(request: RestartDeploymentRequest): Promise<RestartDeploymentResponse> {
    try {
      const { namespace, name } = request;
      
      const restartedAt = new Date().toISOString();
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': restartedAt,
              },
            },
          },
        },
      };
      
      await this.appsApi.patchNamespacedDeployment({
        name,
        namespace,
        body: patch
      });
      
      return {
        success: true,
        message: `Deployment ${name} restart initiated`,
        restartedAt,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  async getRolloutStatus(request: RolloutStatusRequest): Promise<RolloutStatusResponse> {
    try {
      const { namespace, name } = request;
      
      const response = await this.appsApi.readNamespacedDeployment({ name, namespace });
      const deployment = response;
      
      return {
        success: true,
        status: this.determineRolloutStatus(deployment),
        replicas: {
          desired: deployment.spec?.replicas || 0,
          current: deployment.status?.replicas || 0,
          updated: deployment.status?.updatedReplicas || 0,
          available: deployment.status?.availableReplicas || 0,
          unavailable: deployment.status?.unavailableReplicas || 0,
        },
        conditions: deployment.status?.conditions,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  private determineRolloutStatus(deployment: k8s.V1Deployment): string {
    const desired = deployment.spec?.replicas || 0;
    const updated = deployment.status?.updatedReplicas || 0;
    const available = deployment.status?.availableReplicas || 0;
    
    if (updated < desired) {
      return 'Progressing';
    }
    if (available < desired) {
      return 'Waiting for rollout to finish';
    }
    if (updated === desired && available === desired) {
      return 'Deployment successfully rolled out';
    }
    return 'Unknown';
  }

  // ============================================================================
  // Service Operations
  // ============================================================================

  async getServices(request: GetServicesRequest): Promise<GetServicesResponse> {
    try {
      const { namespace, labelSelector, fieldSelector, limit, allNamespaces } = request;
      
      let response;
      if (allNamespaces || !namespace) {
        const params: any = {};
        if (fieldSelector) params.fieldSelector = fieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.k8sApi.listServiceForAllNamespaces(params);
      } else {
        const params: any = { namespace };
        if (fieldSelector) params.fieldSelector = fieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.k8sApi.listNamespacedService(params);
      }
      
      return {
        success: true,
        services: response.items,
        count: response.items.length,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  async getEvents(request: GetEventsRequest): Promise<GetEventsResponse> {
    try {
      const { namespace, labelSelector, fieldSelector, limit, allNamespaces, involvedObjectName, involvedObjectKind, eventType } = request;
      
      let combinedFieldSelector = fieldSelector || '';
      
      if (involvedObjectName) {
        combinedFieldSelector += (combinedFieldSelector ? ',' : '') + `involvedObject.name=${involvedObjectName}`;
      }
      if (involvedObjectKind) {
        combinedFieldSelector += (combinedFieldSelector ? ',' : '') + `involvedObject.kind=${involvedObjectKind}`;
      }
      if (eventType) {
        combinedFieldSelector += (combinedFieldSelector ? ',' : '') + `type=${eventType}`;
      }
      
      let response;
      if (allNamespaces || !namespace) {
        const params: any = {};
        if (combinedFieldSelector) params.fieldSelector = combinedFieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.k8sApi.listEventForAllNamespaces(params);
      } else {
        const params: any = { namespace };
        if (combinedFieldSelector) params.fieldSelector = combinedFieldSelector;
        if (labelSelector) params.labelSelector = labelSelector;
        if (limit !== undefined && limit !== null) params.limit = limit;
        
        response = await this.k8sApi.listNamespacedEvent(params);
      }
      
      return {
        success: true,
        events: response.items,
        count: response.items.length,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  // ============================================================================
  // Resource Metrics Operations
  // ============================================================================

  async getTopPods(request: TopPodsRequest): Promise<TopPodsResponse> {
    try {
      const { namespace } = request;
      
      // Note: This requires metrics-server to be installed in the cluster
      const response = namespace
        ? await this.metricsApi.getPodMetrics(namespace)
        : await this.metricsApi.getPodMetrics();
      
      const metrics = response.items.map((item: any) => ({
        namespace: item.metadata.namespace,
        name: item.metadata.name,
        cpu: this.sumContainerMetrics(item.containers, 'cpu'),
        memory: this.sumContainerMetrics(item.containers, 'memory'),
        containers: item.containers.map((c: any) => ({
          name: c.name,
          cpu: c.usage.cpu,
          memory: c.usage.memory,
        })),
      }));
      
      return {
        success: true,
        metrics,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }

  private sumContainerMetrics(containers: any[], resource: 'cpu' | 'memory'): string {
    // Simple concatenation for now - proper aggregation would require parsing units
    return containers.map(c => c.usage[resource]).join(' + ');
  }

  // ============================================================================
  // Exec Operations
  // ============================================================================

  async execCommand(request: ExecRequest): Promise<ExecResponse> {
    try {
      const { namespace, pod, container, command, tty = false } = request;
      
      let stdout = '';
      let stderr = '';
      
      await this.exec.exec(
        namespace,
        pod,
        container || '',
        command,
        process.stdout as any,
        process.stderr as any,
        null, // stdin not supported in this implementation
        tty
      );
      
      return {
        success: true,
        stdout,
        stderr,
        exitCode: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.handleK8sError(error),
      };
    }
  }
}
