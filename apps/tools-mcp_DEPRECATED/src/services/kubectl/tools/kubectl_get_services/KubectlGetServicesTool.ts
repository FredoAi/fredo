import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetServicesRequest } from '../../model.js';

export class KubectlGetServicesTool extends BaseTool {
  readonly name = 'kubectl_get_services';
  readonly description = 'Use when investigating networking, service discovery, or load balancer configuration. Requires: namespace (string, or allNamespaces=true). Does NOT: modify services, show pod-level details, test connectivity. Returns: service name, type (ClusterIP/NodePort/LoadBalancer), cluster IP, external IP, ports, selectors. Combine with kubectl_get_pods to troubleshoot service-to-pod connections.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'List services in a namespace',
      description: 'Get all services running in the default namespace',
      input: { namespace: 'default' }
    },
    {
      title: 'Find database services across all namespaces',
      description: 'Search for services with tier=database label',
      input: { allNamespaces: true, labelSelector: 'tier=database' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace (omit for all namespaces)' },
      allNamespaces: { type: 'boolean', description: 'List services from all namespaces' },
      labelSelector: { type: 'string', description: 'Label selector' },
      fieldSelector: { type: 'string', description: 'Field selector' },
      limit: { type: 'number', description: 'Maximum number of services' },
    },
  };

  async execute(input: GetServicesRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_get_services_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const result = await service.controller.getServices(input);
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
