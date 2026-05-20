import { BaseTool, ToolInputSchema, ToolExample, ToolHTTPEndpoint } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import { validateQuery, sanitizeQuery } from '../../../../utils/queryValidator.js';
import { Database } from '../../../../core/db.js';

/**
 * Strip OTel span rows to reduce token usage:
 * - tags/attributes trimmed to first 5 keys (http.method, http.status, etc. —
 *   the LLM only needs a few to understand the operation)
 * - logs array dropped entirely (span-level log events are virtually never used
 *   by the LLM for reasoning and can add thousands of chars per span)
 */
function trimTracesRows(rows: any[]): any[] {
  return rows.map(row => {
    const trimmed: any = { ...row };
    // Drop span-level logs
    if ('logs' in trimmed) delete trimmed.logs;
    // Trim tags/attributes to first 5 keys
    for (const field of ['tags', 'attributes']) {
      if (trimmed[field] && typeof trimmed[field] === 'object' && !Array.isArray(trimmed[field])) {
        const keys = Object.keys(trimmed[field]);
        if (keys.length > 5) {
          const t: Record<string, unknown> = {};
          keys.slice(0, 5).forEach(k => { t[k] = trimmed[field][k]; });
          trimmed[field] = t;
        }
      }
    }
    return trimmed;
  });
}

/**
 * Traces Query Tool
 * Executes SELECT queries against the traces table
 */
export class TracesQueryTool extends BaseTool {
  readonly name = 'traces_query';
  readonly description = 'Use when investigating slow requests, tracing API calls across services, or analyzing latency patterns. Queries PostgreSQL traces table (OpenTelemetry spans). REQUIRED: LIMIT clause, PostgreSQL syntax. Does NOT: use SQLite syntax, modify traces, provide real-time tracing. Schema: trace_id, span_id, operation_name, start_time, end_time, duration (μs), status (ok/error). Duration in microseconds (1000000μs = 1s). Use for finding slow operations (duration > 1000000). Ask for latency threshold if unclear.';

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'SQL SELECT query to execute against the traces table. Must be a valid SELECT statement. Examples: "SELECT * FROM traces WHERE trace_id = \'abc123\' ORDER BY start_time", "SELECT operation_name, AVG(duration) FROM traces GROUP BY operation_name"'
      }
    },
    required: ['query'],
    additionalProperties: false
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get all spans for a trace',
      description: 'Retrieve complete trace hierarchy by trace_id',
      input: {
        query: 'SELECT * FROM traces WHERE trace_id = \'abc123def456\' ORDER BY start_time ASC'
      },
      output: {
        description: 'Returns all spans in chronological order',
        example: {
          success: true,
          row_count: 5,
          rows: [
            {
              id: 1,
              trace_id: 'abc123def456',
              span_id: '1234567890abcdef',
              parent_span_id: null,
              operation_name: 'GET /api/users',
              start_time: '2025-11-18T10:30:00Z',
              end_time: '2025-11-18T10:30:01Z',
              duration: 1000000,
              status: 'ok',
              tags: { 'http.method': 'GET', 'http.status_code': 200 },
              logs: [],
              created_at: '2025-11-18T10:30:01Z'
            }
          ]
        }
      }
    },
    {
      title: 'Get average operation duration',
      description: 'Calculate average duration for each operation',
      input: {
        query: 'SELECT operation_name, AVG(duration) as avg_duration_us, COUNT(*) as call_count FROM traces WHERE duration IS NOT NULL GROUP BY operation_name ORDER BY avg_duration_us DESC LIMIT 10'
      },
      output: {
        description: 'Returns operation performance statistics',
        example: {
          success: true,
          row_count: 10,
          rows: [
            {
              operation_name: 'database_query',
              avg_duration_us: 250000,
              call_count: 1500
            },
            {
              operation_name: 'api_request',
              avg_duration_us: 150000,
              call_count: 3000
            }
          ]
        }
      }
    },
    {
      title: 'Find slow operations',
      description: 'Identify operations exceeding performance threshold',
      input: {
        query: 'SELECT trace_id, span_id, operation_name, duration, tags FROM traces WHERE duration > 1000000 ORDER BY duration DESC LIMIT 20'
      },
      output: {
        description: 'Returns slow operations for investigation',
        example: {
          success: true,
          row_count: 20,
          rows: [
            {
              trace_id: 'xyz789',
              span_id: 'abcd1234',
              operation_name: 'external_api_call',
              duration: 5000000,
              tags: { 'http.url': 'https://api.example.com' }
            }
          ]
        }
      }
    }
  ];

  readonly notes = [
    'Only SELECT queries are permitted - no INSERT, UPDATE, DELETE, or DDL operations',
    'Queries are validated to prevent SQL injection',
    'Duration is stored in microseconds (1 second = 1,000,000 microseconds)',
    'Tags field is JSONB - use -> or ->> operators for querying',
    'Use trace_id to get complete trace hierarchies',
    'Use parent_span_id to reconstruct trace trees',
    'Correlate with logs using trace_id field',
    'Check the table schema in documentation before writing queries'
  ];

  readonly relatedTools = [
    'logs_query',
    'metrics_query',
    'tools_documentation'
  ];

  readonly exposedAs = 'both' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly httpEndpoint: ToolHTTPEndpoint = {
    method: 'POST',
    path: '/query',
    description: 'Execute read-only SQL queries against the traces table',
    example: 'curl -X POST http://localhost:3000/api/v1/traces-query/query -H "Content-Type: application/json" -d \'{"query": "SELECT * FROM traces WHERE trace_id = \'abc123\' ORDER BY start_time"}\'',
    responseSchema: {
      successShape: {
        success: { type: 'boolean' },
        row_count: { type: 'integer' },
        rows: { type: 'array' }
      }
    }
  };

  /**
   * Execute the SELECT query against traces table
   */
  async execute(input: { query: string }, context?: any): Promise<any> {
    const { query } = input;
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `traces_query_${Date.now()}`;

    // Validate query
    const validation = validateQuery(query);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        row_count: 0,
        rows: []
      };
    }

    // Sanitize query
    const sanitizedQuery = sanitizeQuery(query);

    try {
      await publisher.publishInit(this.name, sessionId, input, correlationId);
      const db = Database.getInstance();
      const result = await db.query(sanitizedQuery);

      const response = {
        success: true,
        row_count: result.rowCount || 0,
        rows: trimTracesRows(result.rows || [])
      };
      await publisher.publishResponse(this.name, sessionId, response, correlationId);
      return response;

    } catch (error: any) {
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

export default TracesQueryTool;
