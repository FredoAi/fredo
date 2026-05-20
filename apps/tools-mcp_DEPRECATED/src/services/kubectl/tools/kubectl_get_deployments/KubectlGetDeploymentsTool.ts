import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetDeploymentsRequest } from '../../model.js';

export class KubectlGetDeploymentsTool extends BaseTool {
  readonly name = 'kubectl_get_deployments';
  readonly description = 'Use when you need deployment names for restart/scale operations, or checking deployment health. REQUIRED BEFORE: kubectl_restart_deployment, kubectl_scale_deployment to get EXACT deployment names. Requires: namespace (string, or allNamespaces=true). Does NOT: modify deployments, restart pods, show pod-level details. Returns: deployment names, replicas (desired/ready/available), age, images. Always call this before any deployment modification.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'List all deployments in production namespace',
      description: 'Retrieve all deployments running in the production namespace',
      input: { namespace: 'production' }
    },
    {
      title: 'Find frontend deployments across all namespaces',
      description: 'Search for deployments with app=frontend label in all namespaces',
      input: { allNamespaces: true, labelSelector: 'app=frontend' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace (omit for all namespaces)' },
      allNamespaces: { type: 'boolean', description: 'List deployments from all namespaces' },
      labelSelector: { type: 'string', description: 'Label selector (e.g., "app=frontend")' },
      fieldSelector: { type: 'string', description: 'Field selector' },
      limit: { type: 'number', description: 'Maximum number of deployments to return' },
    },
  };

  async execute(input: GetDeploymentsRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_get_deployments_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const result = await service.controller.getDeployments(input);
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
