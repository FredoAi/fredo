import { BaseTool, ToolInputSchema, ToolExample, ToolHTTPEndpoint } from '../../../../core/BaseTool.js';

/**
 * Infrastructure Stream Tool
 * Returns SSE stream URL for real-time infrastructure updates
 */
export class InfrastructureStreamTool extends BaseTool {
  readonly name = 'infrastructure_stream';
  readonly description = 'Use for live monitoring - provides SSE stream URL for real-time cluster changes. Do NOT call unless user explicitly requests live monitoring or you need continuous updates. Does NOT: return diagram data directly (use infrastructure_snapshot), guarantee immediate updates. Returns: stream URL. Browser auto-subscribes. Updates flow automatically when nodes/edges change. Rarely needed - infrastructure_snapshot sufficient for most cases.';

  readonly exposedAs = 'api' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly httpEndpoint: ToolHTTPEndpoint = {
    method: 'GET',
    path: '/stream-url',
    description: 'Get SSE stream URL for real-time infrastructure updates',
    example: 'curl http://localhost:3000/api/v1/infrastructure-diagram/stream-url',
    responseSchema: {
      successShape: {
        type: 'object',
        properties: {
          streamUrl: { type: 'string' },
          protocol: { type: 'string' },
          updateTypes: { type: 'array' },
          instructions: { type: 'object' },
          workflow: { type: 'object' },
          eventFormat: { type: 'object' },
        },
      },
    },
  };

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get stream URL',
      description: 'Retrieve SSE stream URL for real-time updates',
      input: {},
      output: {
        description: 'Stream URL and connection info',
        example: {
          streamUrl: 'http://localhost:3000/api/v1/infrastructure-diagram/stream',
          protocol: 'Server-Sent Events (SSE)',
          updateTypes: ['node_added', 'node_updated', 'node_removed', 'edge_added', 'edge_removed'],
          instructions: 'Use EventSource API or curl -N to subscribe',
        },
      },
    },
  ];

  readonly notes = [
    'Returns the URL for SSE stream subscription',
    'Stream emits incremental graph updates in real-time',
    'Use EventSource API in browsers or curl -N for testing',
    'Updates include node and edge additions, updates, and removals',
    'Connection includes heartbeat every 30 seconds',
    'Subscribe after getting initial snapshot with infrastructure_snapshot',
  ];

  readonly relatedTools = ['infrastructure_snapshot'];

  /**
   * Execute the tool
   */
  async execute(_input: {}, _context?: any): Promise<any> {
    // Determine base URL based on environment
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
    const streamUrl = `${baseUrl}/api/v1/infrastructure-diagram/stream`;

    return {
      streamUrl,
      protocol: 'Server-Sent Events (SSE)',
      updateTypes: [
        'node_added',
        'node_updated',
        'node_removed',
        'edge_added',
        'edge_removed',
      ],
      instructions: {
        browser: 'const eventSource = new EventSource(streamUrl); eventSource.onmessage = (event) => console.log(JSON.parse(event.data));',
        curl: `curl -N ${streamUrl}`,
        description: 'Subscribe to receive real-time infrastructure changes',
      },
      workflow: {
        step1: 'Call infrastructure_snapshot to get initial state',
        step2: 'Subscribe to this stream for real-time updates',
        step3: 'Apply incremental updates to maintain live view',
      },
      eventFormat: {
        node_added: { type: 'node_added', node: '{}', timestamp: 'ISO8601' },
        node_updated: { type: 'node_updated', node: '{}', timestamp: 'ISO8601' },
        node_removed: { type: 'node_removed', nodeId: 'string', timestamp: 'ISO8601' },
        edge_added: { type: 'edge_added', edge: '{}', timestamp: 'ISO8601' },
        edge_removed: { type: 'edge_removed', edgeId: 'string', timestamp: 'ISO8601' },
      },
      timestamp: new Date().toISOString(),
    };
  }
}

export default InfrastructureStreamTool;
