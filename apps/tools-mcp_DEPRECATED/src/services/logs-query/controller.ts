import type { LogQueryRequest, LogQueryResponse } from './model.js';
import { LogsQueryRepository } from './repository.js';

/**
 * Logs Query Controller
 * Business logic layer for log query operations
 */
export class LogsQueryController {
  constructor(private repository: LogsQueryRepository) {}

  async executeQuery(request: LogQueryRequest): Promise<LogQueryResponse> {
    // Controller delegates to repository for query execution
    return await this.repository.executeQuery(request);
  }
}
