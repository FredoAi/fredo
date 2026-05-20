# metrics_query

Execute SELECT queries on application metrics stored in the `metrics` table. This table contains OpenTelemetry-compliant metrics data including counters, gauges, histograms, and summaries from monitored applications.

## ⚠️ CRITICAL: PostgreSQL Syntax Only

**This tool uses PostgreSQL - NOT SQLite:**

### ✅ CORRECT PostgreSQL:
- `NOW() - INTERVAL '1 hour'` for time ranges
- `NOW() - INTERVAL '7 days'` for weekly data
- `timestamp >= NOW() - INTERVAL '24 hours'` for filtering
- `TIMESTAMPTZ` data type

### ❌ WRONG SQLite (DO NOT USE):
- ❌ `datetime('now', '-1 hour')` → Use `NOW() - INTERVAL '1 hour'`
- ❌ `datetime('now')` → Use `NOW()`
- ❌ SQLite date functions → Use PostgreSQL INTERVAL syntax

## ⚠️ Performance Considerations

- **Use LIMIT**: Always add `LIMIT` clause to control result size
- **Indexed Fields**: Queries on `name`, `timestamp`, `type` are optimized
- **Recent Data**: Partial index exists for last 30 days of data
- **JSONB Queries**: Use `labels` JSONB field for dimensional filtering (GIN indexed)
- **Aggregations**: Recommended for large time ranges to reduce data transfer

## Parameters

- `query` (string, required): SQL SELECT statement

## Table Schema

```sql
CREATE TABLE metrics (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,              -- Metric name (e.g., 'cpu_usage', 'http_requests')
  value DOUBLE PRECISION NOT NULL,         -- Numeric metric value
  timestamp TIMESTAMPTZ NOT NULL,          -- Metric collection time
  labels JSONB DEFAULT '{}',               -- Key-value dimensions (e.g., {"host": "server1", "env": "prod"})
  type VARCHAR(20) NOT NULL,               -- Metric type: 'counter', 'gauge', 'histogram', 'summary'
  unit VARCHAR(50),                        -- Unit of measurement (e.g., 'bytes', 'seconds', 'requests')
  created_at TIMESTAMPTZ DEFAULT NOW()     -- Record insertion time
);

-- Optimized Indexes
CREATE INDEX idx_metrics_name ON metrics(name);
CREATE INDEX idx_metrics_timestamp ON metrics(timestamp);
CREATE INDEX idx_metrics_type ON metrics(type);
CREATE INDEX idx_metrics_name_timestamp ON metrics(name, timestamp);
CREATE INDEX idx_metrics_labels ON metrics USING GIN(labels);  -- For JSONB queries
CREATE INDEX idx_metrics_recent ON metrics(timestamp, name)     -- Partial index for recent data
  WHERE timestamp >= NOW() - INTERVAL '30 days';
```

## Available Metric Types

- **counter**: Monotonically increasing values (e.g., total requests, errors)
- **gauge**: Point-in-time measurements (e.g., CPU usage, memory, active connections)
- **histogram**: Distribution of values (e.g., request latency buckets)
- **summary**: Statistical summaries (e.g., quantiles, averages)

## Example Queries

### Basic Queries
```sql
-- Get recent CPU usage metrics
SELECT timestamp, value, labels
FROM metrics
WHERE name = 'cpu_usage' AND type = 'gauge'
ORDER BY timestamp DESC
LIMIT 100;

-- Find all counter metrics
SELECT DISTINCT name, unit
FROM metrics
WHERE type = 'counter'
ORDER BY name;
```

### Aggregations
```sql
-- Average metric values by name and type
SELECT name, type, AVG(value) as avg_value, COUNT(*) as sample_count
FROM metrics
WHERE timestamp >= NOW() - INTERVAL '1 hour'
GROUP BY name, type
ORDER BY avg_value DESC;

-- Time-series data with 5-minute buckets
SELECT 
  date_trunc('minute', timestamp) as time_bucket,
  AVG(value) as avg_value,
  MAX(value) as max_value
FROM metrics
WHERE name = 'memory_usage'
  AND timestamp >= NOW() - INTERVAL '24 hours'
GROUP BY time_bucket
ORDER BY time_bucket;
```

### JSONB Label Queries
```sql
-- Filter by specific label values
SELECT timestamp, name, value, labels
FROM metrics
WHERE labels @> '{"host": "server1"}'
ORDER BY timestamp DESC
LIMIT 50;

-- Query nested JSONB fields
SELECT name, AVG(value) as avg_value
FROM metrics
WHERE labels->>'environment' = 'production'
  AND type = 'gauge'
GROUP BY name;
```

## Response Format

```json
{
  "success": true,
  "row_count": 5,
  "execution_time_ms": 45,
  "rows": [
    {
      "id": 12,
      "name": "http_requests_total",
      "value": 1523,
      "timestamp": "2025-11-18T10:30:00Z",
      "labels": {"method": "GET", "status": "200"},
      "type": "counter",
      "unit": "requests"
    }
  ]
}
```
