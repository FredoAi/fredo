-- Migration: Drop old logs table (replaced by application_logs)
-- Created: 2026-01-29

-- Drop old logs table and its indexes
DROP TABLE IF EXISTS logs CASCADE;

-- Note: The application_logs table (created in 009) is now the primary logs table
-- It contains DNN application logs ingested via OpenTelemetry from Z:\*.log.resources
-- Current data: 4M+ logs with 100% parse success rate
