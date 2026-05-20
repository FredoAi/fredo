import { BaseTool, ToolInputSchema, ToolExample, ToolHTTPEndpoint } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import type { LogQueryRequest } from '../../model.js';
import { LogsQueryService } from '../../service.js';

/**
 * Truncate high-cardinality string fields per row to prevent a single
 * logs_query response from consuming 15K+ tokens (Java stacks alone can be
 * 2,500 chars × 20 rows = 50K chars). LLM still gets actionable signal.
 */
function trimLogRows(rows: any[]): any[] {
  return rows.map(row => {
    const trimmed: any = { ...row };
    if (typeof trimmed.message === 'string' && trimmed.message.length > 300) {
      trimmed.message = trimmed.message.slice(0, 300) + '…';
    }
    if (typeof trimmed.stack_trace === 'string' && trimmed.stack_trace.length > 200) {
      trimmed.stack_trace = trimmed.stack_trace.slice(0, 200) + '…';
    }
    return trimmed;
  });
}

/**
 * Logs Query Tool
 * Executes SELECT queries against the application_logs table (4M+ DNN logs)
 */
export class LogsQueryTool extends BaseTool {
  readonly name = 'logs_query';
  readonly description = 'Use when investigating errors, patterns, or application behavior over time (not real-time). Queries PostgreSQL application_logs table (4M+ rows). REQUIRED: LIMIT clause (default 20, max 1000), PostgreSQL syntax (NOW() - INTERVAL, ILIKE, DATE_TRUNC). Does NOT: use SQLite syntax, modify logs, access logs outside retention. Schema: timestamp (TIMESTAMPTZ), level (DEBUG/INFO/WARN/ERROR/FATAL), logger, message, stack_trace, host, thread_id. Always include timestamp filter. Use kubectl_logs for real-time container logs. Ask user for time range if unclear.';
  private service: LogsQueryService;

  constructor(service: LogsQueryService) {
    super();
    this.service = service;
  }

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'SQL SELECT query to execute against application_logs table. Must include LIMIT clause for large result sets. Use WHERE clauses to filter by timestamp, level, host, logger. Full-text search available on message, stack_trace, logger, host, thread_id fields.'
      },
      timeout_ms: {
        type: 'number',
        description: 'Query timeout in milliseconds (default: 30000). Increase for complex queries on large dataset.',
        default: 30000
      }
    },
    required: ['query'],
    additionalProperties: false
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Recent ERROR logs',
      description: 'Get the 20 most recent error logs with preview',
      input: {
        query: 'SELECT timestamp, host, level, logger, LEFT(message, 100) as message_preview FROM application_logs WHERE level = \'ERROR\' ORDER BY timestamp DESC LIMIT 20'
      },
      output: {
        description: 'Returns array of error log records',
        example: {
          success: true,
          row_count: 20,
          execution_time_ms: 245,
          rows: [
            {
              timestamp: '2025-04-13T00:33:55.021Z',
              host: 'N20-TR-PTLW005P',
              level: 'ERROR',
              logger: 'DotNetNuke.Services.Exceptions.Exceptions',
              message_preview: '~/Default.aspx?tabid=59&error=An unexpected error has occurred'
            }
          ]
        }
      }
    },
    {
      title: 'Count errors by logger (last 24h)',
      description: 'Aggregate error count grouped by logger to identify the noisiest components',
      input: {
        query: "SELECT logger, COUNT(*) as error_count FROM application_logs WHERE level = 'ERROR' AND timestamp >= NOW() - INTERVAL '24 hours' GROUP BY logger ORDER BY error_count DESC LIMIT 10"
      }
    },
    {
      title: 'Full-text search for a specific error',
      description: 'Search message text for a keyword across all log levels',
      input: {
        query: "SELECT timestamp, level, host, message FROM application_logs WHERE message ILIKE '%NullReferenceException%' ORDER BY timestamp DESC LIMIT 50",
        timeout_ms: 60000
      }
    }
  ];

  readonly notes = [
    '⚠️ Table contains 4 million+ logs - ALWAYS use LIMIT clause',
    'Only SELECT queries permitted - no writes allowed (read-only user)',
    'Default query timeout: 30 seconds (configurable via timeout_ms parameter)'
  ];

  readonly relatedTools = [
    'metrics_query',
    'traces_query',
    'tools_documentation'
  ];

  readonly exposedAs = 'both' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly httpEndpoint: ToolHTTPEndpoint = {
    method: 'POST',
    path: '/query',
    description: 'Execute read-only SQL queries against the application_logs table (4M+ DNN logs)',
    example: 'curl -X POST http://localhost:3000/api/v1/logs-query/query -H "Content-Type: application/json" -d \'{"query": "SELECT * FROM application_logs WHERE level = \'ERROR\' LIMIT 20", "timeout_ms": 30000}\'',
    responseSchema: {
      successShape: {
        success: { type: 'boolean' },
        row_count: { type: 'integer' },
        rows: { type: 'array' },
        warning: { type: 'string', optional: true },
        execution_time_ms: { type: 'integer' }
      }
    }
  };

  /**
   * Execute the SELECT query against application_logs table
   */
  async execute(input: { query: string; timeout_ms?: number }, context?: any): Promise<any> {
    console.log('[LogsQueryTool] Received input:', JSON.stringify(input, null, 2));
    console.log('[LogsQueryTool] Query value:', input?.query, 'Type:', typeof input?.query);

    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `logs_query_${Date.now()}`;

    const request: LogQueryRequest = {
      query: input.query,
      timeout_ms: input.timeout_ms
    };

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const result = await this.service.controller.executeQuery(request);
      if (Array.isArray(result.rows)) result.rows = trimLogRows(result.rows);
      console.log('[LogsQueryTool] Result:', JSON.stringify(result, null, 2));
      await publisher.publishResponse(this.name, sessionId, result, correlationId);
      return result;
    } catch (error: any) {
      console.error('[LogsQueryTool] Error:', error);
      await publisher.publishError(this.name, sessionId, error, correlationId);
      return {
        success: false,
        error: `Query execution failed: ${error.message}`,
        row_count: 0,
        rows: []
      };
    }
  }
}

export default LogsQueryTool;
