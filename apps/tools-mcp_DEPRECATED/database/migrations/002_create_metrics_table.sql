-- Migration: Create metrics table for OpenTelemetry compliance
-- Created: 2025-11-02

-- Create metrics table for application metrics
CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  labels JSONB DEFAULT '{}',
  type VARCHAR(20) NOT NULL CHECK (type IN ('counter', 'gauge', 'histogram', 'summary')),
  unit VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(type);
CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp ON metrics(name, timestamp);

-- Create GIN index for labels JSONB queries
CREATE INDEX IF NOT EXISTS idx_metrics_labels ON metrics USING GIN(labels);

-- Create partial index for recent metrics (last 30 days)
CREATE INDEX IF NOT EXISTS idx_metrics_recent ON metrics(timestamp, name) 
WHERE timestamp >= NOW() - INTERVAL '30 days';

-- Add table comment for documentation
COMMENT ON TABLE metrics IS 'OpenTelemetry metrics data storage';
COMMENT ON COLUMN metrics.name IS 'Metric name identifier';
COMMENT ON COLUMN metrics.value IS 'Numeric metric value';
COMMENT ON COLUMN metrics.labels IS 'Key-value pairs for metric dimensions';
COMMENT ON COLUMN metrics.type IS 'Metric type: counter, gauge, histogram, or summary';
COMMENT ON COLUMN metrics.unit IS 'Unit of measurement (e.g., bytes, seconds, requests)';