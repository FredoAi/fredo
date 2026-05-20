-- Migration: Create read-only user for logs-query service
-- Created: 2026-01-29

-- Create read-only user for querying logs
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'logs_reader') THEN
    CREATE USER logs_reader WITH PASSWORD 'logs_read_only_pass';
  END IF;
END
$$;

-- Grant connection to database
GRANT CONNECT ON DATABASE atlas TO logs_reader;

-- Grant usage on schema
GRANT USAGE ON SCHEMA public TO logs_reader;

-- Grant SELECT on application_logs table
GRANT SELECT ON application_logs TO logs_reader;

-- Add comment for documentation
COMMENT ON ROLE logs_reader IS 'Read-only user for logs-query service to access application_logs table';
