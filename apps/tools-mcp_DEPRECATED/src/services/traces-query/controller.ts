import type { TraceQueryRequest, TraceQueryResponse } from './model.js';
import { TracesQueryRepository } from './repository.js';

/**
 * Traces Query Controller
 * Business logic layer for trace query operations
 */
export class TracesQueryController {
  constructor(private repository: TracesQueryRepository) {}

  async executeQuery(request: TraceQueryRequest): Promise<TraceQueryResponse> {
    return await this.repository.executeQuery(request);
  }
}
