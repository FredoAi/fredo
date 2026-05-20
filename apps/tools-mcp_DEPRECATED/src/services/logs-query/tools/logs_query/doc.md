# logs_query

Execute SELECT queries on DNN application logs stored in the `application_logs` table. This table contains **4 million+ logs** from DNN application servers, ingested via OpenTelemetry from production log files.

## ⚠️ CRITICAL: PostgreSQL Syntax Only

**This tool uses PostgreSQL - NOT SQLite:**

### ✅ CORRECT PostgreSQL:
- `NOW() - INTERVAL '24 hours'` for time ranges
- `NOW() - INTERVAL '1 hour'` for recent data
- `DATE_TRUNC('hour', timestamp)` for grouping
- `ILIKE` for case-insensitive string matching

### ❌ WRONG SQLite (DO NOT USE):
- ❌ `datetime('now', '-24 hours')` → Use `NOW() - INTERVAL '24 hours'`
- ❌ `datetime('now')` → Use `NOW()` or `CURRENT_TIMESTAMP`
- ❌ `strftime()` → Use `DATE_TRUNC()` or `TO_CHAR()`

## ⚠️ Performance Considerations

- **Large Dataset**: Table contains 4M+ rows and growing
- **Use LIMIT**: Always add `LIMIT` clause to avoid excessive data transfer
- **Query Timeout**: Default 30s timeout; increase via `timeout_ms` parameter if needed
- **Indexed Fields**: Queries on `timestamp`, `level`, `host`, `logger` are optimized
- **Full-Text Search**: Use `message`, `stack_trace`, `logger`, `host`, `thread_id` for text searches

## Parameters

- `query` (string, required): SQL SELECT statement
- `timeout_ms` (number, optional): Query timeout in milliseconds (default: 30000)

## Table Schema

```sql
CREATE TABLE application_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  host VARCHAR(100) NOT NULL,          -- DNN server (e.g., 'N20-TR-PTLW002P')
  thread_id VARCHAR(50),                -- Thread (e.g., 'Thread:31')
  level VARCHAR(20) NOT NULL,           -- DEBUG, INFO, WARN, ERROR, FATAL
  logger TEXT,                          -- Logger name (e.g., 'DotNetNuke.Services.Exceptions.Exceptions')
  message TEXT NOT NULL,                -- Log message (may include stack traces)
  stack_trace TEXT,                     -- Extracted stack trace
  file_path VARCHAR(500) NOT NULL,      -- Source file path
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Optimized Indexes (5 GIN indexes for full-text search)
CREATE INDEX idx_application_logs_timestamp ON application_logs(timestamp);
CREATE INDEX idx_application_logs_level ON application_logs(level);
CREATE INDEX idx_application_logs_host ON application_logs(host);
CREATE INDEX idx_application_logs_message_search ON application_logs USING GIN(to_tsvector('english', message));
CREATE INDEX idx_application_logs_stack_trace_search ON application_logs USING GIN(to_tsvector('english', stack_trace));
CREATE INDEX idx_application_logs_logger_search ON application_logs USING GIN(to_tsvector('english', logger));
CREATE INDEX idx_application_logs_host_search ON application_logs USING GIN(to_tsvector('english', host));
CREATE INDEX idx_application_logs_thread_search ON application_logs USING GIN(to_tsvector('english', thread_id));
```

## Example Queries

### Basic Queries
```sql
-- Recent error logs (always use LIMIT!)
SELECT timestamp, host, logger, LEFT(message, 100) as message_preview
FROM application_logs 
WHERE level = 'ERROR' 
ORDER BY timestamp DESC 
LIMIT 20;

-- Count logs by severity level
SELECT level, COUNT(*) as count 
FROM application_logs 
GROUP BY level 
ORDER BY count DESC;

-- Logs from specific host in last hour
SELECT timestamp, level, logger, message
FROM application_logs
WHERE host = 'N20-TR-PTLW002P' 
  AND timestamp >= NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC
LIMIT 100;
```

### Full-Text Search (Using GIN Indexes)
```sql
-- Search error messages containing "database"
SELECT timestamp, host, logger, message
FROM application_logs
WHERE level = 'ERROR'
  AND to_tsvector('english', message) @@ to_tsquery('english', 'database')
ORDER BY timestamp DESC
LIMIT 50;

-- Search stack traces for specific exception
SELECT timestamp, host, logger, stack_trace
FROM application_logs
WHERE stack_trace IS NOT NULL
  AND to_tsvector('english', stack_trace) @@ to_tsquery('english', 'NullReferenceException')
LIMIT 30;

-- Find logs by logger name pattern
SELECT timestamp, level, logger, LEFT(message, 80) as message_preview
FROM application_logs
WHERE to_tsvector('english', logger) @@ to_tsquery('english', 'DotNetNuke & Exception')
ORDER BY timestamp DESC
LIMIT 50;
```

### Advanced Analysis
```sql
-- Top 10 loggers by error count
SELECT logger, COUNT(*) as error_count
FROM application_logs
WHERE level IN ('ERROR', 'FATAL')
GROUP BY logger
ORDER BY error_count DESC
LIMIT 10;

-- Hourly error distribution for last 24 hours
SELECT DATE_TRUNC('hour', timestamp) as hour, COUNT(*) as error_count
FROM application_logs
WHERE level = 'ERROR'
  AND timestamp >= NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;

-- Errors by host (server distribution)
SELECT host, COUNT(*) as error_count
FROM application_logs
WHERE level IN ('ERROR', 'FATAL')
  AND timestamp >= NOW() - INTERVAL '7 days'
GROUP BY host
ORDER BY error_count DESC;
```

### Performance Tips
```sql
-- ✅ GOOD: Filtered with timestamp + LIMIT
SELECT * FROM application_logs 
WHERE timestamp >= '2025-01-01' 
  AND level = 'ERROR' 
LIMIT 100;

-- ❌ BAD: No LIMIT, returns millions of rows
SELECT * FROM application_logs;

-- ✅ GOOD: Use indexes for filtering
SELECT * FROM application_logs 
WHERE host = 'N20-TR-PTLW002P' 
  AND level = 'ERROR' 
ORDER BY timestamp DESC 
LIMIT 50;

-- ✅ GOOD: Efficient full-text search with GIN index
SELECT * FROM application_logs
WHERE to_tsvector('english', message) @@ to_tsquery('english', 'timeout & connection')
LIMIT 100;
```

## Common Patterns

### Finding Specific Errors
```sql
-- NullReferenceException errors
SELECT timestamp, host, logger, message, stack_trace
FROM application_logs
WHERE level = 'ERROR'
  AND (message ILIKE '%NullReferenceException%' OR stack_trace ILIKE '%NullReferenceException%')
ORDER BY timestamp DESC
LIMIT 20;
```

### Tracking Error Trends
```sql
-- Daily error count for last 30 days
SELECT DATE(timestamp) as date, COUNT(*) as errors
FROM application_logs
WHERE level = 'ERROR'
  AND timestamp >= NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp)
ORDER BY date DESC;
```

### Debugging Specific Issues
```sql
-- All logs from failing thread
SELECT timestamp, level, logger, message
FROM application_logs
WHERE thread_id = 'Thread:31'
  AND timestamp BETWEEN '2025-01-29 10:00:00' AND '2025-01-29 11:00:00'
ORDER BY timestamp ASC;
```