import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetPodsRequest, GetPodsResponse } from '../../model.js';

/**
 * Trim the full K8s pod list to the minimal surface needed for navigation.
 * get_pods is a naming lookup — the LLM only needs enough to pick exact pod
 * names and spot obvious problems at a glance. Anything deeper belongs in
 * kubectl_describe_pod (conditions, events, resources, probes, lastState).
 *
 * Returns per pod: name, namespace, phase, ready flag, highest restart count,
 * and a brief status reason (CrashLoopBackOff, ImagePullBackOff, OOMKilled, etc.)
 * when the pod is not healthy — enough to triage without describing.
 */
function trimPodsResult(result: GetPodsResponse): object {
  if (!result.success || !result.pods) return result;

  const pods = result.pods.map((pod: any) => {
    const meta = pod.metadata ?? {};
    const status = pod.status ?? {};
    const containerStatuses: any[] = status.containerStatuses ?? [];

    const allReady = containerStatuses.length > 0 && containerStatuses.every((cs: any) => cs.ready);
    const maxRestarts = containerStatuses.reduce((m: number, cs: any) => Math.max(m, cs.restartCount ?? 0), 0);

    // Derive a human-readable status reason for unhealthy containers
    let statusReason: string | undefined;
    if (!allReady) {
      for (const cs of containerStatuses) {
        const waiting = cs.state?.waiting;
        const terminated = cs.state?.terminated;
        if (waiting?.reason) { statusReason = waiting.reason; break; }
        if (terminated?.reason && terminated.reason !== 'Completed') { statusReason = terminated.reason; break; }
      }
    }

    const entry: Record<string, any> = {
      name: meta.name ?? pod.name,
      namespace: meta.namespace ?? pod.namespace,
      phase: status.phase ?? pod.phase,
      ready: allReady,
      restarts: maxRestarts,
    };
    if (statusReason) entry.statusReason = statusReason;

    return entry;
  });

  return { success: true, pods, count: pods.length };
}

/**
 * Kubectl Get Pods Tool
 * List pods in namespace with optional filters
 */
export class KubectlGetPodsTool extends BaseTool {
  readonly name = 'kubectl_get_pods';
  readonly description = 'Use when you need real-time pod status, health, or names from the cluster. REQUIRED BEFORE: kubectl_logs, kubectl_delete_pod, kubectl_describe_pod to get EXACT pod names. Requires: namespace (string, or allNamespaces=true). Does NOT: modify cluster state, create pods, restart pods, return detailed conditions/events/resources. Returns: lightweight list — name, namespace, phase, ready flag, restart count, and statusReason (e.g. CrashLoopBackOff) when unhealthy. For full pod details (events, probes, resource limits, conditions) use kubectl_describe_pod. Always ask user for namespace if unclear.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: {
        type: 'string',
        description: 'Kubernetes namespace (omit for all namespaces)',
      },
      allNamespaces: {
        type: 'boolean',
        description: 'List pods from all namespaces',
      },
      labelSelector: {
        type: 'string',
        description: 'Label selector (e.g., "app=frontend,tier=web")',
      },
      fieldSelector: {
        type: 'string',
        description: 'Field selector (e.g., "status.phase=Running")',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of pods to return',
      },
    },
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'List pods in namespace',
      description: 'Get all pods in production namespace',
      input: { namespace: 'production' }
    },
    {
      title: 'List running pods',
      description: 'Get all running pods across all namespaces',
      input: { allNamespaces: true, fieldSelector: 'status.phase=Running' }
    }
  ];

  async execute(input: GetPodsRequest, context?: any): Promise<any> {
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_get_pods_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      // Get the service instance
      const service = globalThis.__kubectlService;
      if (!service) {
        throw new Error('Kubectl service not initialized');
      }

      const raw = await service.controller.getPods(input);
      const result = trimPodsResult(raw);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
