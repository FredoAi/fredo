-- Migration: Create migration tracking table
-- Created: 2025-11-02

-- Create table to track database migrations
CREATE TABLE IF NOT EXISTS migration_log (
  id SERIAL PRIMARY KEY,
  migration_name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  checksum VARCHAR(64), -- SHA-256 hash of migration content
  execution_time_ms INTEGER,
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT
);

-- Create index for migration queries
CREATE INDEX IF NOT EXISTS idx_migration_log_applied_at ON migration_log(applied_at);

-- Insert initial migration records
INSERT INTO migration_log (migration_name, applied_at, success) VALUES
  ('001_create_traces_table.sql', NOW(), TRUE),
  ('002_create_metrics_table.sql', NOW(), TRUE),
  ('003_create_logs_table.sql', NOW(), TRUE),
  ('004_create_migration_log.sql', NOW(), TRUE)
ON CONFLICT (migration_name) DO NOTHING;

-- Add table comment
COMMENT ON TABLE migration_log IS 'Database migration tracking and history';