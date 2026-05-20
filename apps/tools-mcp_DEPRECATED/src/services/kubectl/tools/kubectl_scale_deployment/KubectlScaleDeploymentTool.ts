import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { ScaleDeploymentRequest } from '../../model.js';

export class KubectlScaleDeploymentTool extends BaseTool {
  readonly name = 'kubectl_scale_deployment';
  readonly description = 'Use when user needs to increase/decrease pod replicas for load or cost reasons. ALWAYS call kubectl_get_deployments FIRST for EXACT deployment name and current replica count. Requires: namespace (string), name (EXACT deployment name), replicas (integer). Does NOT: work with partial names, modify HPA (Horizontal Pod Autoscaler), guarantee immediate scaling. Show current vs target replicas. Suggest kubectl_rollout_status to track progress.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Scale up a deployment',
      description: 'Increase replicas from current to 5 for handling more traffic',
      input: { namespace: 'production', name: 'frontend-app', replicas: 5 }
    },
    {
      title: 'Scale down to conserve resources',
      description: 'Reduce replicas to 1 during low-traffic periods',
      input: { namespace: 'staging', name: 'backend-api', replicas: 1 }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'Deployment name' },
      replicas: { type: 'number', description: 'Desired number of replicas' },
    },
    required: ['namespace', 'name', 'replicas'],
  };

  async execute(input: ScaleDeploymentRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_scale_deployment_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      // Update: Scaling deployment
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'scaling',
        message: `Scaling deployment ${input.name} to ${input.replicas} replicas`,
      }, correlationId);

      const result = await service.controller.scaleDeployment(input);

      // Update: Updating replicas
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'updating',
        message: 'Waiting for replicas to update',
        currentReplicas: result.currentReplicas,
        desiredReplicas: result.desiredReplicas,
      }, correlationId);

      // Wait a bit for scaling to stabilize
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Update: Stable
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'stable',
        message: 'Scaling operation complete',
      }, correlationId);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
