-- Migration: Create logs table for structured logging
-- Created: 2025-11-02

-- Create logs table for structured application logs
CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  level VARCHAR(20) NOT NULL CHECK (level IN ('error', 'warn', 'info', 'debug')),
  message TEXT NOT NULL,
  service VARCHAR(255),
  operation VARCHAR(255),
  trace_id VARCHAR(32), -- Link to traces table
  span_id VARCHAR(16),  -- Link to spans in traces
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  error_stack TEXT,
  error_code VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service);
CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON logs(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logs_level_timestamp ON logs(level, timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_service_timestamp ON logs(service, timestamp) WHERE service IS NOT NULL;

-- Create full-text search index for message content
CREATE INDEX IF NOT EXISTS idx_logs_message_search ON logs USING GIN(to_tsvector('english', message));

-- Create GIN index for metadata JSONB queries
CREATE INDEX IF NOT EXISTS idx_logs_metadata ON logs USING GIN(metadata);

-- Create partial indexes for error logs (more frequently queried)
CREATE INDEX IF NOT EXISTS idx_logs_errors ON logs(timestamp, service) 
WHERE level = 'error';

-- Add table comment for documentation
COMMENT ON TABLE logs IS 'Structured application logs with OpenTelemetry correlation';
COMMENT ON COLUMN logs.level IS 'Log level: error, warn, info, or debug';
COMMENT ON COLUMN logs.trace_id IS 'Optional trace ID for correlation with distributed traces';
COMMENT ON COLUMN logs.span_id IS 'Optional span ID for correlation within a trace';
COMMENT ON COLUMN logs.metadata IS 'Additional structured data associated with the log entry';