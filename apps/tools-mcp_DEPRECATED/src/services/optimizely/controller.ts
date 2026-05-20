import type { OptimizelyRepository } from './repository.js';
import type {
  GetFlagsRequest,
  GetFlagsResponse,
  UpdateFlagRequest,
  UpdateFlagResponse,
} from './model.js';

/**
 * Optimizely Controller — business logic & validation layer.
 */
export class OptimizelyController {
  constructor(private readonly repository: OptimizelyRepository) {}

  async getFlags(request: GetFlagsRequest): Promise<GetFlagsResponse> {
    const validEnvironments = ['production', 'staging', 'development'] as const;
    if (request.environment && !validEnvironments.includes(request.environment as any)) {
      return {
        success: false,
        flags: [],
        total: 0,
        isMockData: false,
      };
    }

    const validStatuses = ['enabled', 'disabled', 'all'] as const;
    if (request.statusFilter && !validStatuses.includes(request.statusFilter as any)) {
      return {
        success: false,
        flags: [],
        total: 0,
        isMockData: false,
      };
    }

    return this.repository.getFlags(request);
  }

  async updateFlag(request: UpdateFlagRequest): Promise<UpdateFlagResponse> {
    if (!request.flagKey || typeof request.flagKey !== 'string') {
      return { success: false, isMockData: false, error: 'flagKey is required' };
    }

    if (/[^a-z0-9_]/.test(request.flagKey)) {
      return {
        success: false,
        isMockData: false,
        error: 'flagKey must contain only lowercase letters, numbers, and underscores',
      };
    }

    if (
      request.rolloutPercentage !== undefined &&
      (request.rolloutPercentage < 0 || request.rolloutPercentage > 100)
    ) {
      return {
        success: false,
        isMockData: false,
        error: 'rolloutPercentage must be between 0 and 100',
      };
    }

    return this.repository.updateFlag(request);
  }
}
