import {
  type OptimizelyFlag,
  type GetFlagsRequest,
  type GetFlagsResponse,
  type UpdateFlagRequest,
  type UpdateFlagResponse,
  loadOptimizelyConfig,
  MOCK_FLAGS,
} from './model.js';

/**
 * Optimizely Repository — Mock / Live dual-mode data access layer.
 *
 * Live mode: Calls the Optimizely REST API using the configured SDK key.
 * Mock mode: Operates on an in-memory copy of MOCK_FLAGS.
 */
export class OptimizelyRepository {
  private config = loadOptimizelyConfig();
  private mockFlags: OptimizelyFlag[] = JSON.parse(JSON.stringify(MOCK_FLAGS));

  async getFlags(request: GetFlagsRequest): Promise<GetFlagsResponse> {
    if (this.config.useMock) {
      return this.getMockFlags(request);
    }
    return this.getLiveFlags(request);
  }

  async updateFlag(request: UpdateFlagRequest): Promise<UpdateFlagResponse> {
    if (this.config.useMock) {
      return this.updateMockFlag(request);
    }
    return this.updateLiveFlag(request);
  }

  // ── Mock implementations ────────────────────────────────────────────────────

  private getMockFlags(request: GetFlagsRequest): GetFlagsResponse {
    let flags = [...this.mockFlags];

    if (request.environment) {
      flags = flags.filter(f => f.environment === request.environment);
    }

    if (request.statusFilter && request.statusFilter !== 'all') {
      const isEnabled = request.statusFilter === 'enabled';
      flags = flags.filter(f => f.enabled === isEnabled);
    }

    return { success: true, flags, total: flags.length, isMockData: true };
  }

  private updateMockFlag(request: UpdateFlagRequest): UpdateFlagResponse {
    const index = this.mockFlags.findIndex(f => f.key === request.flagKey);

    if (index === -1) {
      return {
        success: false,
        isMockData: true,
        error: `Flag '${request.flagKey}' not found`,
      };
    }

    this.mockFlags[index] = {
      ...this.mockFlags[index],
      enabled: request.enabled,
      ...(request.rolloutPercentage !== undefined
        ? { rolloutPercentage: request.rolloutPercentage }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    return { success: true, flag: this.mockFlags[index], isMockData: true };
  }

  // ── Live implementations ────────────────────────────────────────────────────

  private async getLiveFlags(request: GetFlagsRequest): Promise<GetFlagsResponse> {
    try {
      // Flags API: GET /flags/v1/projects/{projectId}/flags
      const url = `${this.config.baseUrl}/projects/${this.config.projectId}/flags`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.sdkKey}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        throw new Error(`Optimizely API returned ${res.status}: ${await res.text()}`);
      }

      const body = await res.json();
      // Response shape: { items: [...], total_count: N }
      const rawItems: any[] = body.items ?? body;
      let flags: OptimizelyFlag[] = this.expandFlagsByEnvironment(rawItems);

      if (request.environment) {
        flags = flags.filter(f => f.environment === request.environment);
      }

      if (request.statusFilter && request.statusFilter !== 'all') {
        const isEnabled = request.statusFilter === 'enabled';
        flags = flags.filter(f => f.enabled === isEnabled);
      }

      return { success: true, flags, total: flags.length, isMockData: false };
    } catch (error: any) {
      throw new Error(`[OptimizelyRepository] getLiveFlags failed: ${error.message}`);
    }
  }

  private async updateLiveFlag(request: UpdateFlagRequest): Promise<UpdateFlagResponse> {
    try {
      const env = request.environment ?? 'production';
      // Enable/disable endpoint: POST .../flags/{key}/environments/{env}/ruleset/enabled|disabled
      const action = request.enabled ? 'enabled' : 'disabled';
      const url = `${this.config.baseUrl}/projects/${this.config.projectId}/flags/${request.flagKey}/environments/${env}/ruleset/${action}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.sdkKey}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, isMockData: false, error: errText };
      }

      // Re-fetch the updated flag and return the relevant environment entry
      const updatedAll = await this.getLiveFlags({ environment: env as any });
      const updated = updatedAll.flags.find(f => f.key === request.flagKey && f.environment === env);
      return { success: true, flag: updated, isMockData: false };
    } catch (error: any) {
      throw new Error(`[OptimizelyRepository] updateLiveFlag failed: ${error.message}`);
    }
  }

  /**
   * Expands each raw flag (which has an `environments` map) into one
   * OptimizelyFlag entry per environment so the UI can filter by env.
   */
  private expandFlagsByEnvironment(items: any[]): OptimizelyFlag[] {
    const result: OptimizelyFlag[] = [];
    for (const raw of items) {
      const envs: Record<string, any> = raw.environments ?? {};
      for (const [envKey, envData] of Object.entries(envs)) {
        result.push({
          id: `${raw.id}-${envKey}`,
          key: raw.key,
          name: raw.name,
          description: raw.description ?? '',
          enabled: envData.enabled ?? false,
          environment: envKey as any,
          rolloutPercentage: 0,
          tags: raw.tags ?? [],
          createdAt: raw.created_time ?? new Date().toISOString(),
          updatedAt: raw.updated_time ?? new Date().toISOString(),
        });
      }
    }
    return result;
  }
}
