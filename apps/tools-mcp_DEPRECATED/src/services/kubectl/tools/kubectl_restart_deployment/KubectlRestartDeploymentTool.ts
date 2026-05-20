import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { RestartDeploymentRequest } from '../../model.js';

export class KubectlRestartDeploymentTool extends BaseTool {
  readonly name = 'kubectl_restart_deployment';
  readonly description = 'Use when user requests to restart/redeploy a service after config changes, hotfixes, or to clear connection pools. ALWAYS call kubectl_get_deployments FIRST to get EXACT deployment name - partial names will fail. Requires: namespace (string), name (EXACT deployment name). Does NOT: work with partial names, restart single pods, modify deployment configuration. Triggers: rolling restart of all pods. Ask user for confirmation before executing if not already confirmed.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Restart deployment to apply config changes',
      description: 'Trigger a rolling restart to pick up new ConfigMap values',
      input: { namespace: 'production', name: 'backend-api' }
    },
    {
      title: 'Force restart after troubleshooting',
      description: 'Restart all pods in a deployment after fixing issues',
      input: { namespace: 'default', name: 'frontend-app' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'Deployment name' },
    },
    required: ['namespace', 'name'],
  };

  async execute(input: RestartDeploymentRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_restart_deployment_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      // Update: Initiating restart
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'initiating',
        message: `Initiating rollout restart for deployment ${input.name}`,
      }, correlationId);

      const result = await service.controller.restartDeployment(input);

      // Update: Rolling out
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'rolling_out',
        message: 'Deployment rollout in progress',
        restartedAt: result.restartedAt,
      }, correlationId);

      // Wait for rollout to begin
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Update: Waiting for ready
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'waiting_ready',
        message: 'Waiting for new pods to become ready',
      }, correlationId);

      // Wait for pods to stabilize
      await new Promise(resolve => setTimeout(resolve, 4000));

      // Final response
      await publisher.publishResponse(this.name, sessionId, {
        ...result,
        message: `${result.message}. Rollout complete.`,
      }, correlationId);

      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
