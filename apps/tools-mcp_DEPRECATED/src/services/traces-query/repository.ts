import { Database } from '../../core/db.js';
import { validateQuery } from '../../utils/queryValidator.js';
import type { TraceQueryRequest, TraceQueryResponse } from './model.js';

/**
 * Traces Query Repository
 * Handles database operations for trace queries
 */
export class TracesQueryRepository {
  private db = Database.getInstance();

  async init(): Promise<void> {
    // Repository initialized with database singleton
  }

  async executeQuery(request: TraceQueryRequest): Promise<TraceQueryResponse> {
    const { query } = request;

    // Validate query is SELECT-only
    const validation = validateQuery(query);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error
      };
    }

    try {
      const result = await this.db.query(query);
      return {
        success: true,
        row_count: result.rows.length,
        rows: result.rows
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}
