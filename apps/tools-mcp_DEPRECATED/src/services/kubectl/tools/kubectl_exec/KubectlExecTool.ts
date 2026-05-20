import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { ExecRequest } from '../../model.js';

export class KubectlExecTool extends BaseTool {
  readonly name = 'kubectl_exec';
  readonly description = 'Use for one-time diagnostic commands inside pod containers (check files, test connectivity, inspect processes). ALWAYS call kubectl_get_pods FIRST for EXACT pod name. Requires: namespace, pod (EXACT name), command (array). Does NOT: work with partial names, provide interactive shell, access persistent terminals. Use for: df, ls, curl, ping. NOT for: long-running processes, interactive debugging. Returns: command stdout/stderr. Prefer kubectl_logs for application logs.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Check disk usage in pod',
      description: 'Run df command to check filesystem usage',
      input: { namespace: 'production', pod: 'app-pod-xyz789', command: ['df', '-h'] }
    },
    {
      title: 'Debug with shell commands',
      description: 'Execute complex shell command to check environment',
      input: { namespace: 'default', pod: 'debug-pod-abc123', command: ['sh', '-c', 'env | grep API'], container: 'app' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      pod: { type: 'string', description: 'Pod name' },
      container: { type: 'string', description: 'Container name (optional, defaults to first container)' },
      command: { 
        type: 'array',
        items: { type: 'string' },
        description: 'Command to execute as array (e.g., ["sh", "-c", "ls -la"])' 
      },
      stdin: { type: 'string', description: 'Optional stdin input' },
      tty: { type: 'boolean', description: 'Allocate a TTY (default: false)' },
    },
    required: ['namespace', 'pod', 'command'],
  };

  async execute(input: ExecRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_exec_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      // Update: Connecting
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'connecting',
        message: `Connecting to pod ${input.pod}`,
      }, correlationId);

      // Update: Executing
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'executing',
        message: `Executing command: ${input.command.join(' ')}`,
      }, correlationId);

      const result = await service.controller.execCommand(input);

      // Update: Capturing output
      await publisher.publishUpdate(this.name, sessionId, {
        status: 'capturing',
        message: 'Capturing command output',
      }, correlationId);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
