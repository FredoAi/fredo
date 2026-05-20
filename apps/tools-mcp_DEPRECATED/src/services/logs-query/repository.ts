import { Pool } from 'pg';
import { validateQuery } from '../../utils/queryValidator.js';
import type { LogQueryRequest, LogQueryResponse } from './model.js';

/**
 * Logs Query Repository
 * Handles database operations for application log queries using read-only credentials
 */
export class LogsQueryRepository {
  private pool: Pool;
  private readonly DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
  private readonly MAX_ROWS_WARNING = 10000; // Warn if result exceeds this

  constructor() {
    // Create dedicated connection pool with read-only user
    this.pool = new Pool({
      host: process.env.DB_HOST || process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.POSTGRES_PORT || '5432'),
      database: process.env.DB_NAME || process.env.POSTGRES_DB || 'atlas',
      user: process.env.LOGS_READER_DB_USER || 'logs_reader',
      password: process.env.LOGS_READER_DB_PASSWORD || 'logs_read_only_pass',
      max: 5, // Limit connections for read-only queries
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async init(): Promise<void> {
    // Skip DB connection test when no DB is configured
    if (!process.env.DB_HOST && !process.env.POSTGRES_HOST) {
      console.warn('[LogsQueryRepository] No DB_HOST configured — skipping connection test (logs-query unavailable)');
      return;
    }
    // Test connection
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log('Logs query repository initialized with read-only user');
    } catch (error: any) {
      console.error('Failed to initialize logs query repository:', error.message);
      throw error;
    }
  }

  async executeQuery(request: LogQueryRequest): Promise<LogQueryResponse> {
    const { query, timeout_ms = this.DEFAULT_TIMEOUT_MS } = request;
    const startTime = Date.now();

    // Validate query is SELECT-only
    const validation = validateQuery(query);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        execution_time_ms: Date.now() - startTime
      };
    }

    // Use default timeout if null or undefined
    const effectiveTimeout = timeout_ms ?? this.DEFAULT_TIMEOUT_MS;
    const timeoutQuery = `SET statement_timeout = ${effectiveTimeout};`;

    try {
      const client = await this.pool.connect();
      try {
        // Set query timeout
        await client.query(timeoutQuery);
        
        // Execute user query
        const result = await client.query(query);
        const executionTime = Date.now() - startTime;

        // Generate warning for large result sets
        let warning: string | undefined;
        if (result.rows.length > this.MAX_ROWS_WARNING) {
          warning = `Result set contains ${result.rows.length} rows. Consider using LIMIT clause to reduce data transfer. Current table has 4M+ logs.`;
        }

        return {
          success: true,
          row_count: result.rows.length,
          rows: result.rows,
          warning,
          execution_time_ms: executionTime
        };
      } finally {
        client.release();
      }
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      
      // Provide helpful error messages
      if (error.message.includes('statement timeout')) {
        return {
          success: false,
          error: `Query timeout after ${timeout_ms}ms. Try adding WHERE clauses to filter data or increase timeout_ms parameter.`,
          execution_time_ms: executionTime
        };
      }

      return {
        success: false,
        error: error.message,
        execution_time_ms: executionTime
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
