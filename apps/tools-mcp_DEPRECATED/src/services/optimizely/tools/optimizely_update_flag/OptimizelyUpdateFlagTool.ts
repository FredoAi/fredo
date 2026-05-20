import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { UpdateFlagRequest } from '../../model.js';

/**
 * Optimizely Update Flag Tool (MCP-only)
 * Enables or disables an Optimizely feature flag and optionally adjusts its rollout percentage.
 */
export class OptimizelyUpdateFlagTool extends BaseTool {
  readonly name = 'optimizely_update_flag';
  readonly description =
    'Enable or disable an Optimizely feature flag by its key. ' +
    'Optionally update the rollout percentage (0–100). ' +
    'Requires flagKey (snake_case) and enabled (boolean). ' +
    'Returns the updated flag state. ' +
    'Use optimizely_get_flags to discover available flag keys.';

  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = false;

  readonly inputSchema = {
    type: 'object' as const,
    required: ['flagKey', 'enabled'],
    properties: {
      flagKey: {
        type: 'string',
        description: 'The snake_case key of the flag to update (e.g. new_dashboard_ui)',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the flag should be enabled (true) or disabled (false)',
      },
      rolloutPercentage: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Percentage of users who will see the flag when enabled (0–100). Omit to keep existing value.',
      },
    },
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Enable a flag',
      description: 'Turn on the new dashboard UI for all users',
      input: { flagKey: 'new_dashboard_ui', enabled: true, rolloutPercentage: 100 },
    },
    {
      title: 'Disable a flag',
      description: 'Turn off the beta query builder',
      input: { flagKey: 'beta_query_builder', enabled: false },
    },
    {
      title: 'Gradual rollout',
      description: 'Enable a flag for 25% of users',
      input: { flagKey: 'ai_copilot_suggestions', enabled: true, rolloutPercentage: 25 },
    },
  ];

  async execute(input: UpdateFlagRequest, context?: any): Promise<any> {
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `optimizely_update_flag_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      const service = globalThis.__optimizelyService;
      if (!service) {
        throw new Error('[OptimizelyUpdateFlagTool] Optimizely service not initialized');
      }

      const result = await service.controller.updateFlag(input);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
