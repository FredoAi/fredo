# traces_query

Execute SELECT queries on distributed tracing data stored in the `traces` table. This table contains OpenTelemetry-compliant span data for analyzing request flows, performance bottlenecks, and service dependencies across microservices.

## ⚠️ CRITICAL: PostgreSQL Syntax Only

**This tool uses PostgreSQL - NOT SQLite:**

### ✅ CORRECT PostgreSQL:
- `start_time >= NOW() - INTERVAL '1 hour'` for time filtering
- `NOW() - INTERVAL '24 hours'` for daily ranges
- `DATE_TRUNC('hour', start_time)` for time grouping
- `TIMESTAMPTZ` for timestamp fields

### ❌ WRONG SQLite (DO NOT USE):
- ❌ `datetime('now', '-1 hour')` → Use `NOW() - INTERVAL '1 hour'`
- ❌ `datetime('now')` → Use `NOW()`
- ❌ SQLite date functions → Use PostgreSQL INTERVAL syntax

## ⚠️ Performance Considerations

- **Use LIMIT**: Always add `LIMIT` clause to control result size
- **Indexed Fields**: Queries on `trace_id`, `start_time`, `operation_name`, `status` are optimized
- **Duration Queries**: Indexed for finding slow operations
- **JSONB Queries**: Use `tags` and `logs` JSONB fields for attribute filtering (GIN indexed)
- **Trace Hierarchies**: Use `parent_span_id` to reconstruct span trees (indexed)

## Parameters

- `query` (string, required): SQL SELECT statement

## Table Schema

```sql
CREATE TABLE traces (
  id SERIAL PRIMARY KEY,
  trace_id VARCHAR(32) NOT NULL,           -- Unique trace identifier (32 hex chars)
  span_id VARCHAR(16) NOT NULL,            -- Unique span identifier (16 hex chars)
  parent_span_id VARCHAR(16),              -- Parent span ID for hierarchy (NULL for root spans)
  operation_name VARCHAR(255) NOT NULL,    -- Operation name (e.g., 'GET /api/users', 'db.query')
  start_time TIMESTAMPTZ NOT NULL,         -- Span start timestamp
  end_time TIMESTAMPTZ,                    -- Span end timestamp (NULL if incomplete)
  duration INTEGER,                        -- Span duration in microseconds (μs)
  status VARCHAR(20) NOT NULL DEFAULT 'ok', -- Span status: 'ok', 'error', 'unset'
  tags JSONB DEFAULT '{}',                 -- Key-value attributes (e.g., {"http.method": "GET"})
  logs JSONB DEFAULT '[]',                 -- Array of structured log entries
  created_at TIMESTAMPTZ DEFAULT NOW(),    -- Record insertion time
  UNIQUE(trace_id, span_id)                -- Enforce uniqueness
);

-- Optimized Indexes
CREATE INDEX idx_traces_trace_id ON traces(trace_id);
CREATE INDEX idx_traces_start_time ON traces(start_time);
CREATE INDEX idx_traces_operation ON traces(operation_name);
CREATE INDEX idx_traces_status ON traces(status);
CREATE INDEX idx_traces_duration ON traces(duration) WHERE duration IS NOT NULL;
CREATE INDEX idx_traces_parent_span ON traces(parent_span_id) WHERE parent_span_id IS NOT NULL;
CREATE INDEX idx_traces_tags ON traces USING GIN(tags);  -- For JSONB queries
```

## Common Use Cases

### Trace Analysis
- **Full Trace Reconstruction**: Query all spans for a `trace_id` to rebuild request flow
- **Performance Analysis**: Find slow operations using `duration` field
- **Error Detection**: Filter by `status = 'error'` to identify failures
- **Service Dependencies**: Use `operation_name` patterns to analyze service calls
- **Log Correlation**: Match trace spans with application logs using `trace_id`

## Example Queries

### Basic Queries
```sql
-- Get complete trace hierarchy
SELECT trace_id, span_id, parent_span_id, operation_name, 
       duration, status, start_time, end_time
FROM traces
WHERE trace_id = 'abc123def456'
ORDER BY start_time ASC;

-- Find recent error spans
SELECT operation_name, trace_id, span_id, duration, tags
FROM traces
WHERE status = 'error'
ORDER BY start_time DESC
LIMIT 50;
```

### Performance Analysis
```sql
-- Find slowest operations (duration in microseconds)
SELECT operation_name, 
       AVG(duration) / 1000 as avg_duration_ms,
       MAX(duration) / 1000 as max_duration_ms,
       COUNT(*) as span_count
FROM traces
WHERE duration IS NOT NULL
  AND start_time >= NOW() - INTERVAL '1 hour'
GROUP BY operation_name
ORDER BY avg_duration_ms DESC
LIMIT 20;

-- Find slow database queries (duration > 100ms)
SELECT trace_id, span_id, operation_name, duration / 1000 as duration_ms, tags
FROM traces
WHERE operation_name LIKE 'db.%'
  AND duration > 100000  -- 100ms in microseconds
ORDER BY duration DESC
LIMIT 100;
```

### JSONB Tag Queries
```sql
-- Filter by HTTP status code
SELECT operation_name, status, tags->>'http.status_code' as http_status,
       duration / 1000 as duration_ms
FROM traces
WHERE tags->>'http.status_code' = '500'
ORDER BY start_time DESC
LIMIT 50;

-- Find traces with specific service
SELECT trace_id, operation_name, duration / 1000 as duration_ms
FROM traces
WHERE tags @> '{"service.name": "api-gateway"}'
ORDER BY duration DESC
LIMIT 100;
```

### Trace Hierarchy Analysis
```sql
-- Get root spans only (no parent)
SELECT trace_id, span_id, operation_name, duration / 1000 as duration_ms
FROM traces
WHERE parent_span_id IS NULL
ORDER BY start_time DESC
LIMIT 50;

-- Count spans per trace (find complex traces)
SELECT trace_id, COUNT(*) as span_count,
       MAX(duration) / 1000 as max_span_duration_ms
FROM traces
GROUP BY trace_id
HAVING COUNT(*) > 10
ORDER BY span_count DESC;
```

## Response Format

```json
{
  "success": true,
  "row_count": 4,
  "execution_time_ms": 23,
  "rows": [
    {
      "id": 1,
      "trace_id": "abc123def456",
      "span_id": "1234567890abcdef",
      "parent_span_id": null,
      "operation_name": "GET /api/users",
      "start_time": "2025-11-18T10:30:00.000Z",
      "end_time": "2025-11-18T10:30:01.234Z",
      "duration": 1234000,
      "status": "ok",
      "tags": {
        "http.method": "GET",
        "http.status_code": "200",
        "service.name": "api-gateway"
      },
      "logs": []
    }
  ]
}
```

## Duration Field Notes

- Duration is stored in **microseconds (μs)**
- To convert to milliseconds: `duration / 1000`
- To convert to seconds: `duration / 1000000`
- NULL duration indicates incomplete or in-progress spans
