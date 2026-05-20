import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { TopPodsRequest } from '../../model.js';

export class KubectlTopPodsTool extends BaseTool {
  readonly name = 'kubectl_top_pods';
  readonly description = 'Use when investigating high CPU/memory, resource quotas, or performance issues. Requires: namespace (or allNamespaces=true), metrics-server running in cluster. Does NOT: work without metrics-server, show historical metrics, modify resources. Returns: current CPU (millicores) and memory (Mi/Gi) per pod. For historical trends, use metrics_query. For limits/requests, use kubectl_describe_pod.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Check resource usage in production',
      description: 'View CPU and memory usage for all pods in production namespace',
      input: { namespace: 'production' }
    },
    {
      title: 'Monitor high-memory pods across all namespaces',
      description: 'Find resource usage for pods with high-memory label',
      input: { allNamespaces: true, labelSelector: 'tier=high-memory' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace (omit for all namespaces)' },
      allNamespaces: { type: 'boolean', description: 'Show metrics for all namespaces' },
      labelSelector: { type: 'string', description: 'Label selector to filter pods' },
    },
  };

  async execute(input: TopPodsRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_top_pods_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const result = await service.controller.getTopPods(input);
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
