import { BaseTool, ToolInputSchema, ToolExample, ToolHTTPEndpoint } from '../../../../core/BaseTool.js';

/**
 * Infrastructure Snapshot Tool
 * Returns complete Kubernetes infrastructure graph
 */
export class InfrastructureSnapshotTool extends BaseTool {
  readonly name = 'infrastructure_snapshot';
  readonly description = 'Use to visualize complete cluster topology at conversation start or after significant changes. No parameters. Does NOT: provide real-time updates (use infrastructure_stream), show historical state. Returns: full K8s graph with nodes (pods/deployments/services/namespaces), edges (relationships), health status. One-time snapshot. Renders interactive diagram in browser. Follow with kubectl tools for specific resource operations.';

  readonly exposedAs = 'api' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly httpEndpoint: ToolHTTPEndpoint = {
    method: 'GET',
    path: '/snapshot',
    description: 'Get complete infrastructure graph snapshot',
    example: 'curl http://localhost:3000/api/v1/infrastructure-diagram/snapshot',
    responseSchema: {
      successShape: {
        type: 'object',
        properties: {
          nodes: { type: 'array' },
          edges: { type: 'array' },
          timestamp: { type: 'string' },
          nodeCount: { type: 'number' },
          edgeCount: { type: 'number' },
        },
      },
    },
  };

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get infrastructure snapshot',
      description: 'Retrieve complete infrastructure graph',
      input: {},
      output: {
        description: 'Complete graph with nodes and edges',
        example: {
          nodes: [
            {
              id: 'namespace-ns-default',
              type: 'namespace',
              name: 'default',
              status: 'healthy',
              metadata: {},
              createdAt: '2025-12-17T10:00:00Z',
            },
            {
              id: 'deployment-deploy-app',
              type: 'deployment',
              name: 'my-app',
              namespace: 'default',
              status: 'healthy',
              metadata: { replicas: 3, readyReplicas: 3 },
              createdAt: '2025-12-17T10:05:00Z',
            },
          ],
          edges: [
            {
              id: 'deployment-deploy-app-owns-pod-app-1',
              sourceId: 'deployment-deploy-app',
              targetId: 'pod-app-1',
              type: 'owns',
            },
          ],
          timestamp: '2025-12-17T10:30:00Z',
        },
      },
    },
  ];

  readonly notes = [
    'Returns a consistent snapshot of the entire infrastructure graph',
    'Includes all nodes (namespaces, deployments, pods, services, etc.)',
    'Includes all relationships (ownership, routing, pod-to-node mapping)',
    'Status is derived server-side and included in the response',
    'Use for initial load or full resync',
  ];

  readonly relatedTools = ['infrastructure_stream'];

  /**
   * Execute the tool
   */
  async execute(_input: {}, _context?: any): Promise<any> {
    try {
      // Get the service instance
      const service = (globalThis as any).__infraService;
      
      if (!service) {
        return {
          nodes: [],
          edges: [],
          timestamp: new Date().toISOString(),
          error: 'Infrastructure service not initialized',
        };
      }

      const snapshot = await service.controller.getSnapshot();
      
      return {
        ...snapshot,
        nodeCount: snapshot.nodes.length,
        edgeCount: snapshot.edges.length,
      };
    } catch (error: any) {
      throw new Error(`Failed to get infrastructure snapshot: ${error.message}`);
    }
  }
}

export default InfrastructureSnapshotTool;
