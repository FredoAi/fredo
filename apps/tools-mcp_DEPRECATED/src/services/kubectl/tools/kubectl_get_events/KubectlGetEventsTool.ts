import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetEventsRequest, GetEventsResponse } from '../../model.js';

/**
 * Trim K8s events to only the fields needed for LLM diagnosis.
 * Raw events carry managedFields, UIDs, resourceVersion, full metadata —
 * none of which the LLM needs. Keep only: type, reason, message, count,
 * timestamps, involved object, and source component.
 */
function trimEventsResult(result: GetEventsResponse): object {
  if (!result.success || !result.events) return result;

  const events = result.events.map((e: any) => ({
    type: e.type,
    reason: e.reason,
    message: e.message,
    count: e.count,
    firstTimestamp: e.firstTimestamp ?? e.eventTime,
    lastTimestamp: e.lastTimestamp ?? e.eventTime,
    involvedObject: e.involvedObject ? {
      kind: e.involvedObject.kind,
      name: e.involvedObject.name,
      namespace: e.involvedObject.namespace,
    } : undefined,
    source: e.source?.component,
  }));

  return { success: true, events, count: events.length };
}

export class KubectlGetEventsTool extends BaseTool {
  readonly name = 'kubectl_get_events';
  readonly description = 'Use when investigating recent cluster issues, pod scheduling failures, or system warnings. Requires: namespace (or allNamespaces=true). Optional: eventType (Normal/Warning/Error). Does NOT: show historical events beyond retention (~1h), modify events. Returns: recent cluster events with timestamp, type, reason, message. Look for: ImagePullBackOff, FailedScheduling, Unhealthy probes. Combine with kubectl_describe_pod for pod-specific events.';
  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get warning events for a namespace',
      description: 'Retrieve all warning events in production namespace',
      input: { namespace: 'production', eventType: 'Warning' }
    },
    {
      title: 'Find events for a specific pod',
      description: 'Get all events related to a particular pod',
      input: { namespace: 'default', involvedObjectName: 'app-pod-123', involvedObjectKind: 'Pod' }
    }
  ];

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace (omit for all namespaces)' },
      allNamespaces: { type: 'boolean', description: 'List events from all namespaces' },
      involvedObjectName: { type: 'string', description: 'Filter by object name' },
      involvedObjectKind: { type: 'string', description: 'Filter by object kind (Pod, Deployment, etc.)' },
      eventType: { type: 'string', enum: ['Normal', 'Warning'], description: 'Event type' },
      limit: { type: 'number', description: 'Maximum number of events' },
    },
  };

  async execute(input: GetEventsRequest, context?: any): Promise<any> {
    const service = globalThis.__kubectlService;
    if (!service) {
      throw new Error('Kubectl service not initialized');
    }

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `kubectl_get_events_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const raw = await service.controller.getEvents(input);
      const result = trimEventsResult(raw);
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
