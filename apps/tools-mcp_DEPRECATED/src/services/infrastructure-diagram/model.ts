/**
 * Graph Model for Kubernetes Infrastructure
 */

export type NodeType = 
  | 'cluster'
  | 'namespace'
  | 'node'
  | 'deployment'
  | 'statefulset'
  | 'daemonset'
  | 'pod'
  | 'service'
  | 'ingress';

export type EdgeType =
  | 'owns'
  | 'routes-to'
  | 'runs-on'
  | 'exposes';

export type NodeStatus = 
  | 'healthy'
  | 'warning'
  | 'error'
  | 'unknown';

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  namespace?: string;
  status: NodeStatus;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  metadata?: Record<string, any>;
}

export interface InfrastructureGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  timestamp: string;
  clusterName?: string;
}

export interface GraphUpdate {
  type: 'node_added' | 'node_updated' | 'node_removed' | 'edge_added' | 'edge_removed';
  node?: GraphNode;
  edge?: GraphEdge;
  nodeId?: string;
  edgeId?: string;
  timestamp: string;
}

/**
 * Kubernetes Resource Store
 */
export interface K8sResource {
  uid: string;
  kind: string;
  name: string;
  namespace?: string;
  resourceVersion: string;
  data: any;
  createdAt: string;
  updatedAt: string;
}
