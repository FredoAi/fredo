import { useState, useEffect, useCallback, useRef } from 'react';
import { Node, Edge } from 'reactflow';
import type { K8sNodeData } from '../components/K8sNode';
import { resolveCollisions } from '../utils/resolveCollisions';
import { API_BASE_URL } from '../../../shared/constants';
import { useStream } from '../../../shared/contexts/StreamContext';

const API_DIAGRAM_BASE = `${API_BASE_URL}/api/v1/infrastructure-diagram`;
const SNAPSHOT_URL = `${API_DIAGRAM_BASE}/snapshot`;

// New infrastructure-diagram API types
interface GraphNode {
  id: string;
  type: 'namespace' | 'node' | 'deployment' | 'statefulset' | 'daemonset' | 'pod' | 'service' | 'ingress';
  name: string;
  namespace?: string;
  status: 'healthy' | 'warning' | 'error' | 'unknown';
  metadata: Record<string, any>;
  createdAt: string;
}

interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'owns' | 'routes-to' | 'runs-on' | 'exposes';
  metadata?: Record<string, any>;
}

interface InfrastructureGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  timestamp: string;
}

interface GraphUpdate {
  type: 'node_added' | 'node_updated' | 'node_removed' | 'edge_added' | 'edge_removed';
  node?: GraphNode;
  edge?: GraphEdge;
  nodeId?: string;
  edgeId?: string;
  timestamp: string;
}

const parseInfrastructureGraphToReactFlow = (data: InfrastructureGraph): { nodes: Node[], edges: Edge[] } => {
  // Get colors from CSS variables
  const rootStyles = getComputedStyle(document.documentElement);
  const healthColors = {
    healthy: rootStyles.getPropertyValue('--status-success').trim() || '#10b981',
    warning: rootStyles.getPropertyValue('--status-warning').trim() || '#f59e0b',
    error: rootStyles.getPropertyValue('--status-error').trim() || '#ef4444',
    unknown: '#6b7280',
  };
  
  // Group nodes by type for better organization
  const nodesByType = new Map<string, GraphNode[]>();
  data.nodes.forEach(node => {
    const type = node.type;
    if (!nodesByType.has(type)) {
      nodesByType.set(type, []);
    }
    nodesByType.get(type)!.push(node);
  });
  
  // Define layer order (top to bottom)
  const typeLayerOrder = [
    'namespace',
    'ingress', 
    'service',
    'deployment',
    'statefulset',
    'daemonset',
    'pod',
    'node'
  ];
  
  // Enhanced spacing to prevent overlaps
  const VERTICAL_SPACING = 250;
  const HORIZONTAL_SPACING = 320;
  const NODES_PER_ROW = 8; // Limit nodes per row for better readability
  
  const nodes: Node<K8sNodeData>[] = [];
  let currentY = 0;
  
  // Layout nodes by type in layers
  typeLayerOrder.forEach((type, layerIndex) => {
    const nodesOfType = nodesByType.get(type) || [];
    
    if (nodesOfType.length === 0) return;
    
    // Group by namespace for better organization (except for namespace and node types)
    if (type !== 'namespace' && type !== 'node') {
      const byNamespace = new Map<string, GraphNode[]>();
      nodesOfType.forEach(node => {
        const ns = node.namespace || 'default';
        if (!byNamespace.has(ns)) {
          byNamespace.set(ns, []);
        }
        byNamespace.get(ns)!.push(node);
      });
      
      // Layout each namespace group
      Array.from(byNamespace.entries()).forEach(([namespace, nsNodes], nsIndex) => {
        nsNodes.forEach((graphNode, index) => {
          const row = Math.floor(index / NODES_PER_ROW);
          const col = index % NODES_PER_ROW;
          
          // Center each row
          const rowWidth = Math.min(nsNodes.length - row * NODES_PER_ROW, NODES_PER_ROW) * HORIZONTAL_SPACING;
          const startX = -rowWidth / 2;
          
          const age = calculateAge(graphNode.createdAt);
          
          nodes.push({
            id: graphNode.id,
            type: 'k8sNode',
            position: { 
              x: startX + col * HORIZONTAL_SPACING + HORIZONTAL_SPACING / 2, 
              y: currentY + row * VERTICAL_SPACING
            },
            data: {
              label: graphNode.name,
              namespace: graphNode.namespace || 'cluster',
              type: graphNode.type,
              health: graphNode.status === 'unknown' ? undefined : graphNode.status,
              age,
              podStatus: graphNode.type === 'pod' ? {
                phase: graphNode.metadata.phase || 'Unknown',
                podIP: graphNode.metadata.podIP,
              } : undefined,
              restartCount: graphNode.metadata.restartCount,
              serviceType: graphNode.metadata.serviceType,
              clusterIP: graphNode.metadata.clusterIP,
              deploymentStatus: (graphNode.type === 'deployment' || graphNode.type === 'statefulset') ? {
                replicas: graphNode.metadata.replicas || 0,
                readyReplicas: graphNode.metadata.readyReplicas,
                availableReplicas: graphNode.metadata.availableReplicas,
              } : undefined,
              resources: graphNode.metadata.resources,
              tooltipButtons: [
                { label: 'Check Logs', action: 'check-logs' },
                { label: 'Improvement Analysis', action: 'improvement-analysis' },
                { label: 'Run Hotfix', action: 'run-hotfix' }
              ]
            },
            zIndex: layerIndex,
            style: {
              zIndex: layerIndex
            }
          });
        });
        
        // Calculate max rows for this namespace group
        const maxRows = Math.ceil(nsNodes.length / NODES_PER_ROW);
        currentY += maxRows * VERTICAL_SPACING;
      });
    } else {
      // Layout namespace and node types in single rows
      nodesOfType.forEach((graphNode, index) => {
        const row = Math.floor(index / NODES_PER_ROW);
        const col = index % NODES_PER_ROW;
        
        const rowWidth = Math.min(nodesOfType.length - row * NODES_PER_ROW, NODES_PER_ROW) * HORIZONTAL_SPACING;
        const startX = -rowWidth / 2;
        
        const age = calculateAge(graphNode.createdAt);
        
        nodes.push({
          id: graphNode.id,
          type: 'k8sNode',
          position: { 
            x: startX + col * HORIZONTAL_SPACING + HORIZONTAL_SPACING / 2, 
            y: currentY + row * VERTICAL_SPACING
          },
          data: {
            label: graphNode.name,
            namespace: graphNode.namespace || 'cluster',
            type: graphNode.type,
            health: graphNode.status === 'unknown' ? undefined : graphNode.status,
            age,
            podStatus: graphNode.type === 'pod' ? {
              phase: graphNode.metadata.phase || 'Unknown',
              podIP: graphNode.metadata.podIP,
            } : undefined,
            restartCount: graphNode.metadata.restartCount,
            serviceType: graphNode.metadata.serviceType,
            clusterIP: graphNode.metadata.clusterIP,
            deploymentStatus: (graphNode.type === 'deployment' || graphNode.type === 'statefulset') ? {
              replicas: graphNode.metadata.replicas || 0,
              readyReplicas: graphNode.metadata.readyReplicas,
              availableReplicas: graphNode.metadata.availableReplicas,
            } : undefined,
            resources: graphNode.metadata.resources,
            tooltipButtons: [
              { label: 'Check Logs', action: 'check-logs' },
              { label: 'Improvement Analysis', action: 'improvement-analysis' },
              { label: 'Run Hotfix', action: 'run-hotfix' }
            ]
          },
          zIndex: layerIndex,
          style: {
            zIndex: layerIndex
          }
        });
      });
      
      const maxRows = Math.ceil(nodesOfType.length / NODES_PER_ROW);
      currentY += maxRows * VERTICAL_SPACING;
    }
    
    // Add extra spacing between type groups
    currentY += VERTICAL_SPACING * 0.5;
  });

  const edges: Edge[] = data.edges.map((graphEdge, index) => ({
    id: graphEdge.id,
    source: graphEdge.sourceId,
    target: graphEdge.targetId,
    animated: graphEdge.type === 'routes-to' || graphEdge.type === 'exposes',
    type: 'smoothstep', // Use smooth step edges for cleaner look
    style: { 
      stroke: 'url(#edge-gradient)', 
      strokeWidth: 2,
      strokeOpacity: 0.5 // Reduce opacity so edges don't clutter the view
    },
  }));

  // Resolve any node collisions before returning
  const collisionFreeNodes = resolveCollisions(nodes, {
    nodeWidth: 250,
    nodeHeight: 100,
    margin: 40,
    maxIterations: 200,
    overlapThreshold: 0.8,
  });

  return { nodes: collisionFreeNodes, edges };
};

// Helper function to calculate age
const calculateAge = (createdAt: string): string => {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
};

export const useDiagram = () => {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { events } = useStream();
  const processedStreamIds = useRef<Set<string>>(new Set());
  
  // Fetch initial snapshot
  const fetchSnapshot = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(SNAPSHOT_URL, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const data: InfrastructureGraph = await response.json();
      
      if (!data.nodes || !Array.isArray(data.nodes)) {
        throw new Error('Invalid infrastructure data: missing nodes array');
      }

      const { nodes: parsedNodes, edges: parsedEdges } = parseInfrastructureGraphToReactFlow(data);
      
      setNodes(parsedNodes);
      setEdges(parsedEdges);
      setError(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load infrastructure';
      setError(errorMessage);
      console.error('Infrastructure fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Apply incremental updates from SSE stream
  const applyGraphUpdate = useCallback((update: GraphUpdate) => {
    switch (update.type) {
      case 'node_added':
      case 'node_updated':
        if (update.node) {
          setNodes(prevNodes => {
            const existingIndex = prevNodes.findIndex(n => n.id === update.node!.id);
            const newNode = createReactFlowNode(update.node!);
            
            if (existingIndex >= 0) {
              // Update existing node
              const updated = [...prevNodes];
              updated[existingIndex] = { ...updated[existingIndex], data: newNode.data };
              return updated;
            } else {
              // Add new node
              return [...prevNodes, newNode];
            }
          });
        }
        break;
        
      case 'node_removed':
        if (update.nodeId) {
          setNodes(prevNodes => prevNodes.filter(n => n.id !== update.nodeId));
          setEdges(prevEdges => prevEdges.filter(e => 
            e.source !== update.nodeId && e.target !== update.nodeId
          ));
        }
        break;
        
      case 'edge_added':
        if (update.edge) {
          const edge = update.edge;
          setEdges(prevEdges => {
            const exists = prevEdges.some(e => e.id === edge.id);
            if (exists) return prevEdges;
            
            const newEdge: Edge = {
              id: edge.id,
              source: edge.sourceId,
              target: edge.targetId,
              animated: edge.type === 'routes-to' || edge.type === 'exposes',
              style: { 
                stroke: 'url(#edge-gradient)', 
                strokeWidth: 2,
                strokeOpacity: 0.75
              },
            };
            return [...prevEdges, newEdge];
          });
        }
        break;
        
      case 'edge_removed':
        if (update.edgeId) {
          setEdges(prevEdges => prevEdges.filter(e => e.id !== update.edgeId));
        }
        break;
    }
  }, []);

  // diagram-reconnect is now a no-op — data comes via Tauri IPC (start_k8s_diagram command).
  // Kept so DiagramFeature.onMount() can still dispatch it without errors.
  useEffect(() => {
    const handleReconnect = () => {
      console.log('[useDiagram] diagram-reconnect received (no-op — use settings to set kubeconfig)');
    };

    window.addEventListener('diagram-reconnect', handleReconnect);
    return () => window.removeEventListener('diagram-reconnect', handleReconnect);
  }, []);

  // Consume infrastructure_stream events emitted by the Tauri k8s service
  useEffect(() => {
    events.forEach((event) => {
      if (event.toolName === 'infrastructure_stream') {
        if (event.state === 'Error') {
          setError(event.data ?? 'Unknown error from k8s service');
          setLoading(false);
        } else if (
          event.state === 'Response' &&
          event.response &&
          event.eventId &&
          !processedStreamIds.current.has(event.eventId)
        ) {
          processedStreamIds.current.add(event.eventId);
          const data = event.response as InfrastructureGraph;
          if (data.nodes && Array.isArray(data.nodes)) {
            const { nodes: n, edges: e } = parseInfrastructureGraphToReactFlow(data);
            setNodes(n);
            setEdges(e);
            setLoading(false);
            setError(null);
          }
        }
      }
    });
  }, [events]);

  return {
    nodes,
    edges,
    loading,
    error,
    refresh: fetchSnapshot,
  };
};

// Helper to create a single ReactFlow node from GraphNode
const createReactFlowNode = (graphNode: GraphNode): Node<K8sNodeData> => {
  const age = calculateAge(graphNode.createdAt);
  
  return {
    id: graphNode.id,
    type: 'k8sNode',
    position: { x: 0, y: 0 }, // Position will be recalculated on full refresh
    data: {
      label: graphNode.name,
      namespace: graphNode.namespace || 'cluster',
      type: graphNode.type,
      health: graphNode.status === 'unknown' ? undefined : graphNode.status,
      age,
      podStatus: graphNode.type === 'pod' ? {
        phase: graphNode.metadata.phase || 'Unknown',
        podIP: graphNode.metadata.podIP,
      } : undefined,
      restartCount: graphNode.metadata.restartCount,
      serviceType: graphNode.metadata.serviceType,
      clusterIP: graphNode.metadata.clusterIP,
      deploymentStatus: (graphNode.type === 'deployment' || graphNode.type === 'statefulset') ? {
        replicas: graphNode.metadata.replicas || 0,
        readyReplicas: graphNode.metadata.readyReplicas,
        availableReplicas: graphNode.metadata.availableReplicas,
      } : undefined,
      resources: graphNode.metadata.resources,
      tooltipButtons: [
        { label: 'Check Logs', action: 'check-logs' },
        { label: 'Improvement Analysis', action: 'improvement-analysis' },
        { label: 'Run Hotfix', action: 'run-hotfix' }
      ]
    },
  };
};
