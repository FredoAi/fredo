import { BaseTool, ToolInputSchema, ToolExample, ToolHTTPEndpoint } from '../../../../core/BaseTool.js';
import { StreamPublisher } from '../../../../lib/stream-publisher/StreamPublisher.js';
import { validateQuery, sanitizeQuery } from '../../../../utils/queryValidator.js';
import { Database } from '../../../../core/db.js';

/**
 * Strip JSONB labels objects to first 5 keys — OTel labels on metrics can contain
 * 20+ entries (k8s pod name, node, deployment, container, env, region...) that
 * the LLM never uses for reasoning but inflate every row significantly.
 */
function trimMetricsRows(rows: any[]): any[] {
  return rows.map(row => {
    if (row.labels && typeof row.labels === 'object' && !Array.isArray(row.labels)) {
      const keys = Object.keys(row.labels);
      if (keys.length > 5) {
        const trimmedLabels: Record<string, unknown> = {};
        keys.slice(0, 5).forEach(k => { trimmedLabels[k] = row.labels[k]; });
        return { ...row, labels: trimmedLabels };
      }
    }
    return row;
  });
}

/**
 * Metrics Query Tool
 * Executes SELECT queries against the metrics table
 */
export class MetricsQueryTool extends BaseTool {
  readonly name = 'metrics_query';
  readonly description = 'Use when analyzing performance trends, resource utilization, or correlating with logs/traces. Queries PostgreSQL metrics table (OpenTelemetry). REQUIRED: LIMIT clause (default 20, max 1000), PostgreSQL syntax (NOW() - INTERVAL, NOT datetime). Does NOT: use SQLite syntax, modify metrics, access metrics outside retention. Schema: name, value (DOUBLE PRECISION), timestamp, labels (JSONB), type (counter/gauge/histogram). Use AVG/SUM/MAX aggregations. Ask for time range if unclear.';

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'SQL SELECT query to execute against the metrics table. Must be a valid SELECT statement. Examples: "SELECT * FROM metrics WHERE name = \'cpu_usage\' LIMIT 10", "SELECT AVG(value) FROM metrics WHERE type = \'gauge\'"'
      }
    },
    required: ['query'],
    additionalProperties: false
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get average metric values by name',
      description: 'Calculate average values for all gauge metrics grouped by name',
      input: {
        query: 'SELECT name, AVG(value) as avg_value, COUNT(*) as sample_count FROM metrics WHERE type = \'gauge\' GROUP BY name ORDER BY avg_value DESC'
      },
      output: {
        description: 'Returns aggregated metric statistics',
        example: {
          success: true,
          row_count: 5,
          rows: [
            { name: 'cpu_usage', avg_value: 65.5, sample_count: 1000 },
            { name: 'memory_usage', avg_value: 45.2, sample_count: 1000 }
          ]
        }
      }
    },
    {
      title: 'Get recent counter metrics',
      description: 'Retrieve latest counter metric values',
      input: {
        query: 'SELECT * FROM metrics WHERE type = \'counter\' ORDER BY timestamp DESC LIMIT 20'
      },
      output: {
        description: 'Returns recent counter metrics',
        example: {
          success: true,
          row_count: 20,
          rows: [
            {
              id: 1,
              name: 'http_requests_total',
              value: 15432,
              timestamp: '2025-11-18T10:30:00Z',
              labels: { method: 'GET', status: '200' },
              type: 'counter',
              unit: 'requests',
              created_at: '2025-11-18T10:30:00Z'
            }
          ]
        }
      }
    },
    {
      title: 'Query metrics by label',
      description: 'Find metrics with specific label values',
      input: {
        query: 'SELECT name, value, timestamp FROM metrics WHERE labels->>\'environment\' = \'production\' AND timestamp >= NOW() - INTERVAL \'1 hour\' ORDER BY timestamp DESC'
      },
      output: {
        description: 'Returns filtered metrics by labels',
        example: {
          success: true,
          row_count: 150,
          rows: [
            {
              name: 'api_latency',
              value: 245.5,
              timestamp: '2025-11-18T10:29:00Z'
            }
          ]
        }
      }
    }
  ];

  readonly notes = [
    'Only SELECT queries are permitted - no INSERT, UPDATE, DELETE, or DDL operations',
    'Queries are validated to prevent SQL injection',
    'Use LIMIT clause to avoid returning excessive data',
    'Labels field is JSONB - use -> or ->> operators for querying',
    'Metric types: counter (cumulative), gauge (point-in-time), histogram, summary',
    'Use time-based filtering for better performance',
    'Check the table schema in documentation before writing queries'
  ];

  readonly relatedTools = [
    'logs_query',
    'traces_query',
    'tools_documentation'
  ];

  readonly exposedAs = 'both' as const;
  readonly deferLoading = true;
  readonly allowProgrammaticCalling = true;

  readonly httpEndpoint: ToolHTTPEndpoint = {
    method: 'POST',
    path: '/query',
    description: 'Execute read-only SQL queries against the metrics table',
    example: 'curl -X POST http://localhost:3000/api/v1/metrics-query/query -H "Content-Type: application/json" -d \'{"query": "SELECT * FROM metrics WHERE type = \'gauge\' LIMIT 20"}\'',
    responseSchema: {
      successShape: {
        success: { type: 'boolean' },
        row_count: { type: 'integer' },
        rows: { type: 'array' }
      }
    }
  };

  /**
   * Execute the SELECT query against metrics table
   */
  async execute(input: { query: string }, context?: any): Promise<any> {
    const { query } = input;
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    const correlationId = `metrics_query_${Date.now()}`;

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
        rows: trimMetricsRows(result.rows || [])
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

export default MetricsQueryTool;
