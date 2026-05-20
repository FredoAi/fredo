import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetLogsRequest } from '../../model.js';

export class KubectlLogsTool extends BaseTool {
  readonly name = 'kubectl_logs';
  readonly description = 'Use when diagnosing pod issues, investigating errors, or analyzing application behavior. ALWAYS call kubectl_get_pods FIRST to get EXACT pod name. Requires: namespace (string), name (EXACT pod name from kubectl_get_pods). Optional: container, previous (for crashed pods), tailLines, timestamps. Does NOT: work with partial pod names, modify logs, access logs beyond pod retention. Use previous=true for crashed pods. Returns: recent container stdout/stderr. Ask for namespace/pod if unclear.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get recent logs from a pod',
      description: 'Retrieve the last 100 lines of logs with timestamps',
      input: { namespace: 'default', name: 'app-pod-abc123', tailLines: 100, timestamps: true }
    },
    {
      title: 'View logs from crashed container',
      description: 'Get logs from the previous instance of a crashed pod',
      input: { namespace: 'production', name: 'worker-pod-xyz789', previous: true, tailLines: 50 }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'Pod name' },
      container: { type: 'string', description: 'Container name (optional, defaults to first container)' },
      previous: { type: 'boolean', description: 'Get logs from previous instance (crashed container)' },
      tailLines: { type: 'number', description: 'Number of lines from the end of logs' },
      timestamps: { type: 'boolean', description: 'Include timestamps in logs' },
      sinceSeconds: { type: 'number', description: 'Only return logs newer than this many seconds' },
    },
    required: ['namespace', 'name'],
  };

  async execute(input: GetLogsRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    // Default to 100 lines — prevents dumping megabytes from high-volume pods.
    // LLM can pass a higher value explicitly when needed.
    if (input.tailLines === undefined) {
      (input as any).tailLines = 100;
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_logs_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const result = await service.controller.getLogs(input);
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
