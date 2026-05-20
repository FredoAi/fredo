-- Migration: Create traces table for OpenTelemetry compliance
-- Created: 2025-11-02

-- Create traces table for distributed tracing data
CREATE TABLE IF NOT EXISTS traces (
  id SERIAL PRIMARY KEY,
  trace_id VARCHAR(32) NOT NULL,
  span_id VARCHAR(16) NOT NULL,
  parent_span_id VARCHAR(16),
  operation_name VARCHAR(255) NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration INTEGER, -- Duration in microseconds
  status VARCHAR(20) NOT NULL DEFAULT 'ok',
  tags JSONB DEFAULT '{}',
  logs JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(trace_id, span_id)
);

-- Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_start_time ON traces(start_time);
CREATE INDEX IF NOT EXISTS idx_traces_operation ON traces(operation_name);
CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
CREATE INDEX IF NOT EXISTS idx_traces_duration ON traces(duration) WHERE duration IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_traces_parent_span ON traces(parent_span_id) WHERE parent_span_id IS NOT NULL;

-- Create GIN index for tags JSONB queries
CREATE INDEX IF NOT EXISTS idx_traces_tags ON traces USING GIN(tags);

-- Add table comment for documentation
COMMENT ON TABLE traces IS 'OpenTelemetry distributed tracing data storage';
COMMENT ON COLUMN traces.trace_id IS 'Unique trace identifier (32 hex characters)';
COMMENT ON COLUMN traces.span_id IS 'Unique span identifier within trace (16 hex characters)';
COMMENT ON COLUMN traces.duration IS 'Span duration in microseconds';
COMMENT ON COLUMN traces.tags IS 'Key-value pairs for span attributes';
COMMENT ON COLUMN traces.logs IS 'Array of structured log entries for the span';