import { EventEmitter } from 'events';
import * as k8s from '@kubernetes/client-node';
import { K8sResource } from './model.js';

/**
 * Kubernetes watcher - watches resources and emits change events
 */
export class KubernetesWatcher extends EventEmitter {
  private kc: k8s.KubeConfig;
  private k8sApi!: k8s.CoreV1Api;
  private appsApi!: k8s.AppsV1Api;
  private networkingApi!: k8s.NetworkingV1Api;
  private watches: Map<string, any> = new Map();
  private isRunning = false;
  private failedWatches: Set<string> = new Set();
  private maxRetries = 3;
  private retryCount: Map<string, number> = new Map();

  constructor() {
    super();
    this.kc = new k8s.KubeConfig();
    
    // Try to load kubeconfig from default locations
    try {
      this.kc.loadFromDefault();
      
      // Patch for Docker environment
      const cluster = this.kc.getCurrentCluster();
      const user = this.kc.getCurrentUser();
      
      if (cluster && cluster.server) {
        
        // Fix Windows paths in kubeconfig (they're now mounted in container)
        if (cluster.caFile && cluster.caFile.includes('C:\\Users\\')) {
          // Extract just the .minikube/... part and prepend /root/
          const minikubePart = cluster.caFile.match(/\.minikube[\\\/].*/);
          if (minikubePart) {
            cluster.caFile = '/root/' + minikubePart[0].replace(/\\/g, '/');
            console.log(`[KubernetesWatcher] Fixed CA file path: ${cluster.caFile}`);
          }
        }
        
        // For development with minikube self-signed certs, disable SSL verification
        // This is the safest approach when running in Docker with host.docker.internal
        (cluster as any).skipTLSVerify = true;
      }
      
      // Fix Windows paths for client certificates
      if (user) {
        if (user.certFile && user.certFile.includes('C:\\Users\\')) {
          const minikubePart = user.certFile.match(/\.minikube[\\\/].*/);
          if (minikubePart) {
            user.certFile = '/root/' + minikubePart[0].replace(/\\/g, '/');
            console.log(`[KubernetesWatcher] Fixed cert file path: ${user.certFile}`);
          }
        }
        if (user.keyFile && user.keyFile.includes('C:\\Users\\')) {
          const minikubePart = user.keyFile.match(/\.minikube[\\\/].*/);
          if (minikubePart) {
            user.keyFile = '/root/' + minikubePart[0].replace(/\\/g, '/');
            console.log(`[KubernetesWatcher] Fixed key file path: ${user.keyFile}`);
          }
        }
      }
      
      // Set NODE_TLS_REJECT_UNAUTHORIZED for the Kubernetes client
      // This is necessary for watch requests which use a different HTTP agent
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      
      console.log('[KubernetesWatcher] Loaded kubeconfig from default location');
    } catch (error) {
      console.log('[KubernetesWatcher] Could not load kubeconfig, will use in-cluster config or mock mode');
      console.error('[KubernetesWatcher] Error:', error);
      // For development without K8s cluster, we'll emit mock data
    }

    // Only create API clients if we have a valid cluster configuration
    try {
      this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
      console.log('[KubernetesWatcher] ✅ Kubernetes API clients initialized');
    } catch (error) {
      console.log('[KubernetesWatcher] ⚠️  No active Kubernetes cluster - running in degraded mode');
      // API clients will be undefined, start() will return early
    }
  }

  /**
   * Start watching Kubernetes resources
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[KubernetesWatcher] Already running');
      return;
    }

    // Check if API clients are initialized (cluster is available)
    if (!this.k8sApi || !this.appsApi || !this.networkingApi) {
      console.log('[KubernetesWatcher] ⚠️  No Kubernetes cluster available - skipping watch initialization');
      return;
    }

    this.isRunning = true;
    console.log('[KubernetesWatcher] Starting watches...');

    try {
      // Watch core resources
      await this.watchPods();
      await this.watchNodes();
      await this.watchServices();
      await this.watchNamespaces();

      // Watch workloads
      await this.watchDeployments();
      await this.watchStatefulSets();
      await this.watchDaemonSets();

      // Watch networking
      await this.watchIngresses();

      console.log('[KubernetesWatcher] All watches started successfully');
    } catch (error) {
      console.error('[KubernetesWatcher] Error starting watches:', error);
      // Emit mock data for development
      this.emitMockData();
    }
  }

  /**
   * Stop all watches
   */
  stop(): void {
    console.log('[KubernetesWatcher] Stopping all watches...');
    this.isRunning = false;

    for (const [key, watch] of this.watches) {
      try {
        watch.abort();
        console.log(`[KubernetesWatcher] Stopped watch: ${key}`);
      } catch (error) {
        console.error(`[KubernetesWatcher] Error stopping watch ${key}:`, error);
      }
    }

    this.watches.clear();
    this.retryCount.clear();
    this.failedWatches.clear();
  }

  /**
   * Watch Pods
   */
  private async watchPods(): Promise<void> {
    await this.watchResource('pods', () => 
      this.k8sApi.listPodForAllNamespaces()
    );
  }

  /**
   * Watch Nodes
   */
  private async watchNodes(): Promise<void> {
    await this.watchResource('nodes', () => 
      this.k8sApi.listNode()
    );
  }

  /**
   * Watch Services
   */
  private async watchServices(): Promise<void> {
    await this.watchResource('services', () =>
      this.k8sApi.listServiceForAllNamespaces()
    );
  }

  /**
   * Watch Namespaces
   */
  private async watchNamespaces(): Promise<void> {
    await this.watchResource('namespaces', () =>
      this.k8sApi.listNamespace()
    );
  }

  /**
   * Watch Deployments
   */
  private async watchDeployments(): Promise<void> {
    await this.watchResource('deployments', () =>
      this.appsApi.listDeploymentForAllNamespaces()
    );
  }

  /**
   * Watch StatefulSets
   */
  private async watchStatefulSets(): Promise<void> {
    await this.watchResource('statefulsets', () =>
      this.appsApi.listStatefulSetForAllNamespaces()
    );
  }

  /**
   * Watch DaemonSets
   */
  private async watchDaemonSets(): Promise<void> {
    await this.watchResource('daemonsets', () =>
      this.appsApi.listDaemonSetForAllNamespaces()
    );
  }

  /**
   * Watch Ingresses
   */
  private async watchIngresses(): Promise<void> {
    await this.watchResource('ingresses', () =>
      this.networkingApi.listIngressForAllNamespaces()
    );
  }

  /**
   * Generic watch function
   */
  private async watchResource(kind: string, _listFn: () => Promise<any>): Promise<void> {
    try {
      const watch = new k8s.Watch(this.kc);
      const path = this.getWatchPath(kind);

      // Start watch but don't await - the promise resolves when watch closes
      watch.watch(
        path,
        {},
        (type, obj) => this.handleWatchEvent(kind, type, obj),
        (err) => this.handleWatchError(kind, err)
      ).catch((err) => {
        console.error(`[KubernetesWatcher] Watch connection error for ${kind}:`, err);
        this.handleWatchError(kind, err);
      });

      this.watches.set(kind, watch);
      console.log(`[KubernetesWatcher] Started watch for ${kind}`);
    } catch (error) {
      console.error(`[KubernetesWatcher] Failed to start watch for ${kind}:`, error);
      throw error;
    }
  }

  /**
   * Get watch path for resource kind
   */
  private getWatchPath(kind: string): string {
    const paths: Record<string, string> = {
      pods: '/api/v1/pods',
      nodes: '/api/v1/nodes',
      services: '/api/v1/services',
      namespaces: '/api/v1/namespaces',
      deployments: '/apis/apps/v1/deployments',
      statefulsets: '/apis/apps/v1/statefulsets',
      daemonsets: '/apis/apps/v1/daemonsets',
      ingresses: '/apis/networking.k8s.io/v1/ingresses',
    };
    return paths[kind] || `/api/v1/${kind}`;
  }

  /**
   * Handle watch event
   */
  private handleWatchEvent(kind: string, type: string, obj: any): void {
    if (!obj?.metadata?.uid) {
      console.warn(`[KubernetesWatcher] Received invalid object for ${kind}`);
      return;
    }

    const resource: K8sResource = {
      uid: obj.metadata.uid,
      kind: obj.kind || kind,
      name: obj.metadata.name,
      namespace: obj.metadata.namespace,
      resourceVersion: obj.metadata.resourceVersion,
      data: obj,
      createdAt: obj.metadata.creationTimestamp || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Emit event based on type
    switch (type) {
      case 'ADDED':
        this.emit('resource:added', resource);
        break;
      case 'MODIFIED':
        this.emit('resource:updated', resource);
        break;
      case 'DELETED':
        this.emit('resource:deleted', resource);
        break;
      default:
        console.warn(`[KubernetesWatcher] Unknown event type: ${type}`);
    }
  }

  /**
   * Handle watch error
   */
  private handleWatchError(kind: string, error: any): void {
    console.error(`[KubernetesWatcher] Watch error for ${kind}:`, error);

    // Check if this is a connection error
    const isConnectionError = error && (error.code === 'ECONNREFUSED' || 
                              error.code === 'ENOTFOUND' ||
                              error.code === 'ETIMEDOUT');

    if (isConnectionError) {
      const currentRetries = this.retryCount.get(kind) || 0;
      
      if (currentRetries >= this.maxRetries) {
        console.warn(`[KubernetesWatcher] Max retries reached for ${kind}. Disabling watch and falling back to mock mode.`);
        this.failedWatches.add(kind);
        this.retryCount.delete(kind);
        
        // Emit mock data if all critical watches have failed
        const criticalWatches = ['pods', 'nodes', 'services', 'namespaces'];
        const allCriticalFailed = criticalWatches.every(w => this.failedWatches.has(w));
        
        if (allCriticalFailed && this.failedWatches.size === criticalWatches.length) {
          console.warn('[KubernetesWatcher] All watches failed. Switching to mock mode.');
          this.emitMockData();
        }
        return;
      }

      this.retryCount.set(kind, currentRetries + 1);
      console.log(`[KubernetesWatcher] Retry ${currentRetries + 1}/${this.maxRetries} for ${kind} in 5 seconds...`);
    }

    // Restart watch after delay
    if (this.isRunning && !this.failedWatches.has(kind)) {
      setTimeout(() => {
        console.log(`[KubernetesWatcher] Restarting watch for ${kind}...`);
        this.restartWatch(kind);
      }, 5000);
    }
  }

  /**
   * Restart a specific watch
   */
  private async restartWatch(kind: string): Promise<void> {
    const watch = this.watches.get(kind);
    if (watch) {
      try {
        watch.abort();
      } catch (error) {
        // Ignore errors during abort
      }
      this.watches.delete(kind);
    }

    // Restart based on kind
    const restartMap: Record<string, () => Promise<void>> = {
      pods: () => this.watchPods(),
      nodes: () => this.watchNodes(),
      services: () => this.watchServices(),
      namespaces: () => this.watchNamespaces(),
      deployments: () => this.watchDeployments(),
      statefulsets: () => this.watchStatefulSets(),
      daemonsets: () => this.watchDaemonSets(),
      ingresses: () => this.watchIngresses(),
    };

    const restartFn = restartMap[kind];
    if (restartFn) {
      await restartFn();
    }
  }

  /**
   * Emit mock data for development/testing
   */
  private emitMockData(): void {
    console.log('[KubernetesWatcher] Emitting mock data for development');

    // Mock namespace
    setTimeout(() => {
      this.emit('resource:added', {
        uid: 'ns-default',
        kind: 'Namespace',
        name: 'default',
        resourceVersion: '1',
        data: { metadata: { name: 'default' } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }, 100);

    // Mock deployment
    setTimeout(() => {
      this.emit('resource:added', {
        uid: 'deploy-app',
        kind: 'Deployment',
        name: 'my-app',
        namespace: 'default',
        resourceVersion: '1',
        data: {
          metadata: { name: 'my-app', namespace: 'default' },
          spec: { replicas: 3 },
          status: { readyReplicas: 3, replicas: 3 },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }, 200);

    // Mock pod
    setTimeout(() => {
      this.emit('resource:added', {
        uid: 'pod-app-1',
        kind: 'Pod',
        name: 'my-app-pod-1',
        namespace: 'default',
        resourceVersion: '1',
        data: {
          metadata: {
            name: 'my-app-pod-1',
            namespace: 'default',
            ownerReferences: [{ uid: 'deploy-app', kind: 'Deployment' }],
          },
          status: { phase: 'Running' },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }, 300);
  }
}
