-- Migration: Create application_logs table for parsed DNN logs
-- Created: 2026-01-29

CREATE TABLE IF NOT EXISTS application_logs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  host VARCHAR(100),
  thread_id VARCHAR(100),
  level VARCHAR(50),
  logger VARCHAR(255),
  message TEXT,
  stack_trace TEXT,
  file_path VARCHAR(512),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common filters
CREATE INDEX IF NOT EXISTS idx_app_logs_timestamp ON application_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_app_logs_level ON application_logs(level);
CREATE INDEX IF NOT EXISTS idx_app_logs_host ON application_logs(host);
CREATE INDEX IF NOT EXISTS idx_app_logs_logger ON application_logs(logger);

-- Full text search for message
CREATE INDEX IF NOT EXISTS idx_app_logs_message_search ON application_logs USING GIN(to_tsvector('english', message));
