import type { MetricQueryRequest, MetricQueryResponse } from './model.js';
import { MetricsQueryRepository } from './repository.js';

/**
 * Metrics Query Controller
 * Business logic layer for metric query operations
 */
export class MetricsQueryController {
  constructor(private repository: MetricsQueryRepository) {}

  async executeQuery(request: MetricQueryRequest): Promise<MetricQueryResponse> {
    return await this.repository.executeQuery(request);
  }
}
