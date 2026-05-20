import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { DescribePodRequest, DescribePodResponse } from '../../model.js';

/**
 * Trim the full k8s API response to only the fields needed for diagnosis.
 * Eliminates ports, duplicate image refs, all-labels bloat, condition timestamps,
 * service account, restartPolicy, podIP/hostIP, qosClass, and caps events at 8.
 * Pass verbose=true to bypass trimming and get the full raw pod spec.
 */
function trimDescribeResult(result: DescribePodResponse, verbose?: boolean): object {
  if (!result.success || !result.pod) return result;
  // verbose mode: return raw response unchanged — useful when LLM needs ports,
  // all labels, full conditions timestamps, or service account info.
  if (verbose) return result;

  const pod = result.pod;
  const meta = pod.metadata ?? {};
  const spec = (pod.spec as any) ?? {};
  const status = pod.status ?? {};

  const containers = (spec.containers ?? []).map((c: any) => ({
    name: c.name,
    image: c.image,
    resources: c.resources,
    readinessProbe: c.readinessProbe ? { defined: true } : undefined,
    livenessProbe: c.livenessProbe ? { defined: true } : undefined,
    // ports omitted — not diagnostic for CrashLoop/Pending/ImagePullBackOff
  }));

  const containerStatuses = (status.containerStatuses ?? []).map((cs: any) => ({
    name: cs.name,
    ready: cs.ready,
    restartCount: cs.restartCount,
    // image omitted — duplicate of containers[].image
    state: cs.state,
    lastState: cs.lastState,
    // started omitted — redundant with ready
  }));

  // Last 8 events cover any CrashLoop or scheduling pattern; source (kubelet) omitted
  const events = (result.events ?? [])
    .slice(-8)
    .map((e: any) => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      count: e.count,
      lastTimestamp: e.lastTimestamp ?? e.eventTime,
    }));

  const initStatuses = status.initContainerStatuses ?? [];

  return {
    success: true,
    pod: {
      name: meta.name,
      namespace: meta.namespace,
      // labels trimmed to app key only — helm/k8s bookkeeping labels add noise
      labels: meta.labels?.app ? { app: meta.labels.app } : undefined,
      creationTimestamp: meta.creationTimestamp,
      node: spec.nodeName,
      // serviceAccount, restartPolicy omitted — not diagnostic
      status: {
        phase: status.phase,
        // podIP, hostIP, qosClass omitted — rarely needed for failure diagnosis
        startTime: status.startTime,
        conditions: (status.conditions ?? []).map((c: any) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
          // lastProbeTime, lastTransitionTime omitted
        })),
        containerStatuses,
        // initContainerStatuses included only when present
        ...(initStatuses.length > 0 ? { initContainerStatuses: initStatuses } : {}),
      },
      containers,
    },
    events,
  };
}

export class KubectlDescribePodTool extends BaseTool {
  readonly name = 'kubectl_describe_pod';
  readonly description = 'Use when investigating pod failures, scheduling issues, or need detailed events/conditions. ALWAYS call kubectl_get_pods FIRST to get EXACT pod name. Requires: namespace (string), name (EXACT pod name). Does NOT: work with partial names, modify pod, access container internals. Returns: events, conditions, volumes, limits, node placement. Use for CrashLoopBackOff, ImagePullBackOff, Pending pods. Pass verbose=true for full spec (ports, all labels, serviceAccount, condition timestamps).';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Describe a specific pod',
      description: 'Get detailed information about the nginx-deployment pod',
      input: { namespace: 'default', name: 'nginx-deployment-7d5c8f9b6d-x8k2m' }
    },
    {
      title: 'Inspect a pod in production',
      description: 'View events and conditions for a backend service pod',
      input: { namespace: 'production', name: 'backend-api-6c7d8f9a5b-p9q3r' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'Pod name' },
      verbose: { type: 'boolean', description: 'Return full pod spec including ports, all labels, serviceAccount, restartPolicy, condition timestamps. Default false — returns diagnosis-optimized subset.' },
    },
    required: ['namespace', 'name'],
  };

  async execute(input: DescribePodRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_describe_pod_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const raw = await service.controller.describePod(input);
      const result = trimDescribeResult(raw, (input as any).verbose);
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
