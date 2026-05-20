import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { RolloutStatusRequest } from '../../model.js';

export class KubectlRolloutStatusTool extends BaseTool {
  readonly name = 'kubectl_rollout_status';
  readonly description = 'Use after kubectl_restart_deployment or kubectl_scale_deployment to track rollout progress. ALWAYS call kubectl_get_deployments FIRST for EXACT deployment name. Requires: namespace, name (EXACT deployment name). Does NOT: work with partial names, trigger rollouts, modify configuration. Returns: rollout state, replicas (desired/updated/ready/available), completion status. Poll every 10-30s until complete.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Check deployment rollout status',
      description: 'Monitor the rollout status of a deployment update',
      input: { namespace: 'production', name: 'backend-api' }
    },
    {
      title: 'Monitor statefulset rollout',
      description: 'Check the rollout status of a statefulset',
      input: { namespace: 'default', name: 'database-cluster', resourceType: 'statefulset' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'Deployment name' },
      resourceType: { 
        type: 'string', 
        enum: ['deployment', 'statefulset', 'daemonset'],
        description: 'Resource type (default: deployment)' 
      },
    },
    required: ['namespace', 'name'],
  };

  async execute(input: RolloutStatusRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_rollout_status_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const result = await service.controller.getRolloutStatus(input);
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
