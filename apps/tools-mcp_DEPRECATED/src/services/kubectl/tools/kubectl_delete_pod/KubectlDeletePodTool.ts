import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { DeletePodRequest } from '../../model.js';

export class KubectlDeletePodTool extends BaseTool {
  readonly name = 'kubectl_delete_pod';
  readonly description = 'Use to force-restart a single stuck/problematic pod (managed pods auto-recreate). ALWAYS call kubectl_get_pods FIRST to get EXACT pod name. Requires: namespace (string), name (EXACT pod name), user confirmation. Does NOT: work with partial names, delete deployments, prevent recreation. DANGER: Deletes live pod immediately. For graceful restarts, use kubectl_restart_deployment instead. Ask for explicit user confirmation before executing.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Force restart a problematic pod',
      description: 'Delete a pod to trigger recreation by its controller',
      input: { namespace: 'production', name: 'app-pod-xyz789' }
    },
    {
      title: 'Delete pod with grace period',
      description: 'Delete a pod with a 30-second grace period',
      input: { namespace: 'default', name: 'worker-pod-abc123', gracePeriodSeconds: 30 }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'Pod name' },
      gracePeriodSeconds: { type: 'number', description: 'Grace period before force kill (default: 0)' },
    },
    required: ['namespace', 'name'],
  };

  async execute(input: DeletePodRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_delete_pod_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      // Update: Deleting pod
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'deleting',
        message: `Deleting pod ${input.name} in namespace ${input.namespace}`,
      }, correlationId);

      const result = await service.controller.deletePod(input);

      // Update: Waiting for new pod (if managed by deployment)
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'waiting',
        message: 'Waiting for new pod to be created by controller',
      }, correlationId);

      // Small delay to allow controller to create new pod
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Final response
      await publisher.publishResponse(this.name, sessionId, {
        ...result,
        message: `${result.message}. New pod will be created by controller.`,
      }, correlationId);

      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
