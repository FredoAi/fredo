import { InfrastructureDiagramRepository } from './repository.js';
import { 
  GraphNode, 
  GraphEdge, 
  InfrastructureGraph, 
  GraphUpdate,
  K8sResource,
  NodeType,
  NodeStatus
} from './model.js';

/**
 * Graph derivation - transforms Kubernetes resources into a graph model
 */
export class GraphDerivation {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();

  constructor(private repository: InfrastructureDiagramRepository) {}

  /**
   * Derive complete graph from current resource state
   */
  deriveGraph(): InfrastructureGraph {
    this.nodes.clear();
    this.edges.clear();

    const resources = this.repository.getAllResources();

    // First pass: create nodes
    for (const resource of resources) {
      const node = this.resourceToNode(resource);
      if (node) {
        this.nodes.set(node.id, node);
      }
    }

    // Second pass: create edges
    for (const resource of resources) {
      const edges = this.deriveEdges(resource);
      for (const edge of edges) {
        this.edges.set(edge.id, edge);
      }
    }

    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Derive graph update from a resource change
   */
  deriveUpdate(resource: K8sResource, changeType: 'added' | 'updated' | 'deleted'): GraphUpdate[] {
    const updates: GraphUpdate[] = [];
    const timestamp = new Date().toISOString();

    if (changeType === 'deleted') {
      // Node removed
      const nodeId = this.getNodeId(resource);
      if (this.nodes.has(nodeId)) {
        this.nodes.delete(nodeId);
        updates.push({
          type: 'node_removed',
          nodeId,
          timestamp,
        });
      }

      // Remove associated edges
      const edgesToRemove = Array.from(this.edges.values()).filter(
        edge => edge.sourceId === nodeId || edge.targetId === nodeId
      );
      for (const edge of edgesToRemove) {
        this.edges.delete(edge.id);
        updates.push({
          type: 'edge_removed',
          edgeId: edge.id,
          timestamp,
        });
      }
    } else {
      // Node added or updated
      const node = this.resourceToNode(resource);
      if (node) {
        const existing = this.nodes.get(node.id);
        this.nodes.set(node.id, node);

        updates.push({
          type: existing ? 'node_updated' : 'node_added',
          node,
          timestamp,
        });
      }

      // Derive edges
      const edges = this.deriveEdges(resource);
      for (const edge of edges) {
        const existing = this.edges.get(edge.id);
        if (!existing) {
          this.edges.set(edge.id, edge);
          updates.push({
            type: 'edge_added',
            edge,
            timestamp,
          });
        }
      }
    }

    return updates;
  }

  /**
   * Convert a Kubernetes resource to a graph node
   */
  private resourceToNode(resource: K8sResource): GraphNode | null {
    const nodeId = this.getNodeId(resource);
    const kind = resource.kind?.toLowerCase();

    let nodeType: NodeType;
    switch (kind) {
      case 'namespace':
        nodeType = 'namespace';
        break;
      case 'node':
        nodeType = 'node';
        break;
      case 'deployment':
        nodeType = 'deployment';
        break;
      case 'statefulset':
        nodeType = 'statefulset';
        break;
      case 'daemonset':
        nodeType = 'daemonset';
        break;
      case 'pod':
        nodeType = 'pod';
        break;
      case 'service':
        nodeType = 'service';
        break;
      case 'ingress':
        nodeType = 'ingress';
        break;
      default:
        return null; // Skip unknown types
    }

    const status = this.deriveStatus(resource);

    return {
      id: nodeId,
      type: nodeType,
      name: resource.name,
      namespace: resource.namespace,
      status,
      metadata: this.extractMetadata(resource),
      createdAt: resource.createdAt,
    };
  }

  /**
   * Derive edges from a resource
   */
  private deriveEdges(resource: K8sResource): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const sourceId = this.getNodeId(resource);

    // OwnerReferences (ownership edges)
    const ownerRefs = resource.data?.metadata?.ownerReferences || [];
    for (const owner of ownerRefs) {
      if (owner.uid) {
        const targetId = `${owner.kind?.toLowerCase()}-${owner.uid}`;
        edges.push({
          id: `${sourceId}-owns-${targetId}`,
          sourceId: targetId, // Owner is source
          targetId: sourceId, // Owned is target
          type: 'owns',
          metadata: { controller: owner.controller },
        });
      }
    }

    // Pod to Node (runs-on)
    if (resource.kind === 'Pod' && resource.data?.spec?.nodeName) {
      const nodeName = resource.data.spec.nodeName;
      // Find node UID
      const nodes = this.repository.getResourcesByKind('Node');
      const node = nodes.find(n => n.name === nodeName);
      if (node) {
        const nodeId = this.getNodeId(node);
        edges.push({
          id: `${sourceId}-runs-on-${nodeId}`,
          sourceId,
          targetId: nodeId,
          type: 'runs-on',
        });
      }
    }

    // Service to Pod (exposes) - via selectors
    if (resource.kind === 'Service' && resource.data?.spec?.selector) {
      const selector = resource.data.spec.selector;
      const pods = this.repository.getResourcesByKind('Pod');
      
      for (const pod of pods) {
        if (this.matchesSelector(pod.data, selector)) {
          const podId = this.getNodeId(pod);
          edges.push({
            id: `${sourceId}-exposes-${podId}`,
            sourceId,
            targetId: podId,
            type: 'exposes',
          });
        }
      }
    }

    // Ingress to Service (routes-to)
    if (resource.kind === 'Ingress' && resource.data?.spec?.rules) {
      const rules = resource.data.spec.rules || [];
      for (const rule of rules) {
        const paths = rule.http?.paths || [];
        for (const path of paths) {
          const serviceName = path.backend?.service?.name;
          if (serviceName) {
            const services = this.repository.getResourcesByKind('Service');
            const service = services.find(
              s => s.name === serviceName && s.namespace === resource.namespace
            );
            if (service) {
              const serviceId = this.getNodeId(service);
              edges.push({
                id: `${sourceId}-routes-to-${serviceId}`,
                sourceId,
                targetId: serviceId,
                type: 'routes-to',
                metadata: { path: path.path },
              });
            }
          }
        }
      }
    }

    return edges;
  }

  /**
   * Derive status from resource
   */
  private deriveStatus(resource: K8sResource): NodeStatus {
    const kind = resource.kind?.toLowerCase();

    switch (kind) {
      case 'pod':
        return this.derivePodStatus(resource.data);
      case 'deployment':
      case 'statefulset':
      case 'daemonset':
        return this.deriveWorkloadStatus(resource.data);
      case 'node':
        return this.deriveNodeStatus(resource.data);
      case 'service':
      case 'ingress':
        return 'healthy'; // Services and ingresses don't have health status
      default:
        return 'unknown';
    }
  }

  /**
   * Derive pod status
   */
  private derivePodStatus(pod: any): NodeStatus {
    const phase = pod?.status?.phase?.toLowerCase();
    
    if (phase === 'running') {
      // Check container statuses
      const containerStatuses = pod?.status?.containerStatuses || [];
      const hasFailures = containerStatuses.some((c: any) => 
        c.restartCount > 5 || c.state?.waiting || c.state?.terminated
      );
      return hasFailures ? 'warning' : 'healthy';
    } else if (phase === 'pending') {
      return 'warning';
    } else if (phase === 'failed' || phase === 'unknown') {
      return 'error';
    }

    return 'unknown';
  }

  /**
   * Derive workload status
   */
  private deriveWorkloadStatus(workload: any): NodeStatus {
    const desired = workload?.spec?.replicas || 0;
    const ready = workload?.status?.readyReplicas || 0;
    const available = workload?.status?.availableReplicas || 0;

    if (ready === 0 && desired > 0) {
      return 'error';
    } else if (ready < desired) {
      return 'warning';
    } else if (ready === desired && ready === available) {
      return 'healthy';
    }

    return 'unknown';
  }

  /**
   * Derive node status
   */
  private deriveNodeStatus(node: any): NodeStatus {
    const conditions = node?.status?.conditions || [];
    const readyCondition = conditions.find((c: any) => c.type === 'Ready');

    if (readyCondition?.status === 'True') {
      return 'healthy';
    } else if (readyCondition?.status === 'Unknown') {
      return 'warning';
    } else {
      return 'error';
    }
  }

  /**
   * Extract relevant metadata from resource
   */
  private extractMetadata(resource: K8sResource): Record<string, any> {
    const metadata: Record<string, any> = {
      uid: resource.uid,
      resourceVersion: resource.resourceVersion,
    };

    const kind = resource.kind?.toLowerCase();

    if (kind === 'pod') {
      metadata.phase = resource.data?.status?.phase;
      metadata.restartCount = resource.data?.status?.containerStatuses?.[0]?.restartCount || 0;
    } else if (kind === 'deployment' || kind === 'statefulset') {
      metadata.replicas = resource.data?.spec?.replicas;
      metadata.readyReplicas = resource.data?.status?.readyReplicas;
    } else if (kind === 'node') {
      metadata.capacity = resource.data?.status?.capacity;
      metadata.allocatable = resource.data?.status?.allocatable;
    }

    return metadata;
  }

  /**
   * Generate node ID from resource
   */
  private getNodeId(resource: K8sResource): string {
    return `${resource.kind?.toLowerCase()}-${resource.uid}`;
  }

  /**
   * Check if pod matches service selector
   */
  private matchesSelector(pod: any, selector: Record<string, string>): boolean {
    const labels = pod?.metadata?.labels || {};
    return Object.entries(selector).every(([key, value]) => labels[key] === value);
  }
}
