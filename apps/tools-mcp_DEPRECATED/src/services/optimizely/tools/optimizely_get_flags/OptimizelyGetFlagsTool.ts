import { BaseTool, ToolExample } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { GetFlagsRequest } from '../../model.js';

/**
 * Optimizely Get Flags Tool
 * Returns all Optimizely feature flags with their current enabled status.
 */
export class OptimizelyGetFlagsTool extends BaseTool {
  readonly name = 'optimizely_get_flags';
  readonly description =
    'Get all Optimizely feature flags and their current status (enabled/disabled). ' +
    'Optional: environment (production, staging, development), statusFilter (enabled, disabled, all). ' +
    'Returns flags with key, name, description, enabled state, rollout percentage, tags, and timestamps. ' +
    'Returns mock data when Optimizely credentials are not configured.';

  readonly exposedAs = 'both' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      environment: {
        type: 'string',
        enum: ['production', 'staging', 'development'],
        description: 'Filter flags by environment. Omit to return flags from all environments.',
      },
      statusFilter: {
        type: 'string',
        enum: ['enabled', 'disabled', 'all'],
        description: 'Filter flags by enabled/disabled status. Omit or use "all" to return all flags.',
      },
    },
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get all flags',
      description: 'Fetch all feature flags regardless of status',
      input: {},
    },
    {
      title: 'Get enabled production flags',
      description: 'Fetch only enabled flags in the production environment',
      input: { environment: 'production', statusFilter: 'enabled' },
    },
    {
      title: 'Get all staging flags',
      description: 'Fetch all flags in the staging environment',
      input: { environment: 'staging' },
    },
  ];

  async execute(input: GetFlagsRequest, context?: any): Promise<any> {
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `optimizely_get_flags_${Date.now()}`;

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);

      const service = globalThis.__optimizelyService;
      if (!service) {
        throw new Error('[OptimizelyGetFlagsTool] Optimizely service not initialized');
      }

      const result = await service.controller.getFlags(input);

      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      await publisher.publishError(this.name, sessionId, error, correlationId);
      throw error;
    }
  }
}
