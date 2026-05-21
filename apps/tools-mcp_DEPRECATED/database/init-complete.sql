-- Fredo Database Initialization Script (Complete)
-- This script initializes the PostgreSQL database with all required tables and seed data

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Set timezone to UTC for consistency
SET timezone = 'UTC';

-- ============================================================================
-- Migration 001: Create traces table for OpenTelemetry compliance
-- ============================================================================

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

CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_start_time ON traces(start_time);
CREATE INDEX IF NOT EXISTS idx_traces_operation ON traces(operation_name);
CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
CREATE INDEX IF NOT EXISTS idx_traces_duration ON traces(duration) WHERE duration IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_traces_parent_span ON traces(parent_span_id) WHERE parent_span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_traces_tags ON traces USING GIN(tags);

COMMENT ON TABLE traces IS 'OpenTelemetry distributed tracing data storage';

-- ============================================================================
-- Migration 002: Create metrics table for OpenTelemetry compliance
-- ============================================================================

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

CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(type);
CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp ON metrics(name, timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_labels ON metrics USING GIN(labels);
-- Removed partial index with NOW() as it's not immutable

COMMENT ON TABLE metrics IS 'OpenTelemetry metrics data storage';

-- ============================================================================
-- Migration 003: Create logs table for structured logging
-- ============================================================================

CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  level VARCHAR(20) NOT NULL CHECK (level IN ('error', 'warn', 'info', 'debug')),
  message TEXT NOT NULL,
  service VARCHAR(255),
  operation VARCHAR(255),
  trace_id VARCHAR(32),
  span_id VARCHAR(16),
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  error_stack TEXT,
  error_code VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service);
CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON logs(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logs_level_timestamp ON logs(level, timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_service_timestamp ON logs(service, timestamp) WHERE service IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logs_message_search ON logs USING GIN(to_tsvector('english', message));
CREATE INDEX IF NOT EXISTS idx_logs_metadata ON logs USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_logs_errors ON logs(timestamp, service) WHERE level = 'error';

COMMENT ON TABLE logs IS 'Structured application logs with OpenTelemetry correlation';

-- ============================================================================
-- Migration 004: Create migration log table
-- ============================================================================

CREATE TABLE IF NOT EXISTS migration_log (
  id SERIAL PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO migration_log (version, name) VALUES
  (1, '001_create_traces_table'),
  (2, '002_create_metrics_table'),
  (3, '003_create_logs_table'),
  (4, '004_create_migration_log'),
  (5, '005_seed_mock_traces'),
  (6, '006_seed_mock_logs'),
  (7, '007_seed_mock_metrics')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- Seed Data: Mock Traces
-- ============================================================================
-- Simulating the rdsuserdisplaycacheapi error scenario from WinSights DEV

-- Trace 1: Successful request (baseline)
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'span001', NULL, 'GET /api/userdisplaycache/users', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours' + INTERVAL '150 milliseconds', 150000, 'ok', 
'{"service": "rdsuserdisplaycacheapi", "environment": "dev", "http.method": "GET", "http.status_code": 200, "tenant_id": "contoso", "pod_name": "rdsuserdisplaycacheapi-b54b998f4-xk7ql"}');

-- Trace 2: Error trace - ArgumentNullException
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags, logs) VALUES
('e1f2g3h4i5j6k7l8m9n0o1p2q3r4s5t6', 'span002', NULL, 'GET /api/userdisplaycache/users', NOW() - INTERVAL '1 hour 30 minutes', NOW() - INTERVAL '1 hour 30 minutes' + INTERVAL '89 milliseconds', 89000, 'error',
'{"service": "rdsuserdisplaycacheapi", "environment": "dev", "http.method": "GET", "http.status_code": 500, "tenant_id": "fabrikam", "pod_name": "rdsuserdisplaycacheapi-b54b998f4-xk7ql", "error": true, "error.kind": "ArgumentNullException"}',
'[{"timestamp": "2025-11-14T15:00:00Z", "level": "error", "message": "Value cannot be null. (Parameter ''tenantId'')"}]');

-- Related spans for error trace
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('e1f2g3h4i5j6k7l8m9n0o1p2q3r4s5t6', 'span002a', 'span002', 'GetTenantUsers', NOW() - INTERVAL '1 hour 30 minutes' + INTERVAL '5 milliseconds', NOW() - INTERVAL '1 hour 30 minutes' + INTERVAL '50 milliseconds', 45000, 'error',
'{"service": "rdsuserdisplaycacheapi", "method": "GetTenantUsers", "error": true}'),
('e1f2g3h4i5j6k7l8m9n0o1p2q3r4s5t6', 'span002b', 'span002', 'SQL: SELECT * FROM UserCache', NOW() - INTERVAL '1 hour 30 minutes' + INTERVAL '10 milliseconds', NOW() - INTERVAL '1 hour 30 minutes' + INTERVAL '45 milliseconds', 35000, 'ok',
'{"db.system": "postgresql", "db.statement": "SELECT * FROM UserCache WHERE tenant_id = $1"}');

-- Trace 3: More errors following the pattern
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('f3g4h5i6j7k8l9m0n1o2p3q4r5s6t7u8', 'span003', NULL, 'GET /api/userdisplaycache/users', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour' + INTERVAL '120 milliseconds', 120000, 'error',
'{"service": "rdsuserdisplaycacheapi", "environment": "dev", "http.method": "GET", "http.status_code": 500, "error": true, "error.kind": "ArgumentNullException"}'),
('g5h6i7j8k9l0m1n2o3p4q5r6s7t8u9v0', 'span004', NULL, 'GET /api/userdisplaycache/users', NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '45 minutes' + INTERVAL '95 milliseconds', 95000, 'error',
'{"service": "rdsuserdisplaycacheapi", "environment": "dev", "http.method": "GET", "http.status_code": 500, "error": true, "error.kind": "ArgumentNullException"}');

-- Trace 4: Recovery - successful after fix
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('h7i8j9k0l1m2n3o4p5q6r7s8t9u0v1w2', 'span005', NULL, 'GET /api/userdisplaycache/users', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes' + INTERVAL '140 milliseconds', 140000, 'ok',
'{"service": "rdsuserdisplaycacheapi", "environment": "dev", "http.method": "GET", "http.status_code": 200, "tenant_id": "contoso"}');

-- ============================================================================
-- Seed Data: Mock Logs
-- ============================================================================

-- Success logs (baseline)
INSERT INTO logs (timestamp, level, message, service, operation, trace_id, span_id, metadata) VALUES
(NOW() - INTERVAL '2 hours', 'info', 'Successfully retrieved user display cache', 'rdsuserdisplaycacheapi', 'GET /api/userdisplaycache/users', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'span001', 
'{"tenant_id": "contoso", "user_count": 42, "cache_hit": true}');

-- Error logs matching the actual error
INSERT INTO logs (timestamp, level, message, service, operation, trace_id, span_id, error_message, error_stack, error_code, metadata) VALUES
(NOW() - INTERVAL '1 hour 30 minutes', 'error', 'ArgumentNullException in GetTenantUsers', 'rdsuserdisplaycacheapi', 'GET /api/userdisplaycache/users', 'e1f2g3h4i5j6k7l8m9n0o1p2q3r4s5t6', 'span002',
'Value cannot be null. (Parameter ''tenantId'')',
'   at WinSights.UserDisplayCache.Services.CacheService.GetTenantUsers(String tenantId)
   at WinSights.UserDisplayCache.Controllers.UserDisplayCacheController.GetUsers()
   at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.TaskOfIActionResultExecutor.Execute()',
'E_ARGUMENT_NULL',
'{"tenant_id": null, "endpoint": "/api/userdisplaycache/users", "pod": "rdsuserdisplaycacheapi-b54b998f4-xk7ql", "namespace": "rds-dev"}');

-- Context logs around the error
INSERT INTO logs (timestamp, level, message, service, operation, metadata) VALUES
(NOW() - INTERVAL '1 hour 30 minutes' - INTERVAL '5 seconds', 'debug', 'Incoming request to GetUsers endpoint', 'rdsuserdisplaycacheapi', 'GET /api/userdisplaycache/users',
'{"request_id": "req-12345", "source_ip": "10.240.0.15"}'),
(NOW() - INTERVAL '1 hour 30 minutes' + INTERVAL '1 second', 'warn', 'Request failed with 500 Internal Server Error', 'rdsuserdisplaycacheapi', 'GET /api/userdisplaycache/users',
'{"status_code": 500, "duration_ms": 89}');

-- More error occurrences
INSERT INTO logs (timestamp, level, message, service, operation, error_message, error_code) VALUES
(NOW() - INTERVAL '1 hour', 'error', 'ArgumentNullException in GetTenantUsers', 'rdsuserdisplaycacheapi', 'GET /api/userdisplaycache/users',
'Value cannot be null. (Parameter ''tenantId'')', 'E_ARGUMENT_NULL'),
(NOW() - INTERVAL '45 minutes', 'error', 'ArgumentNullException in GetTenantUsers', 'rdsuserdisplaycacheapi', 'GET /api/userdisplaycache/users',
'Value cannot be null. (Parameter ''tenantId'')', 'E_ARGUMENT_NULL');

-- Alert/monitoring logs
INSERT INTO logs (timestamp, level, message, service, metadata) VALUES
(NOW() - INTERVAL '1 hour 29 minutes', 'warn', 'High error rate detected for rdsuserdisplaycacheapi', 'monitoring-system',
'{"service": "rdsuserdisplaycacheapi", "error_rate": 0.58, "threshold": 0.05, "alert_rule": "HighAverageErrorRate"}'),
(NOW() - INTERVAL '1 hour 15 minutes', 'info', 'Alert notification sent', 'monitoring-system',
'{"alert_name": "[WinSights DEV] High Average Error Rate - rdsuserdisplaycacheapi", "recipients": "Luke Rogers", "channels": ["email"]}');

-- Recovery logs
INSERT INTO logs (timestamp, level, message, service, operation, metadata) VALUES
(NOW() - INTERVAL '30 minutes', 'info', 'Successfully retrieved user display cache', 'rdsuserdisplaycacheapi', 'GET /api/userdisplaycache/users',
'{"tenant_id": "contoso", "user_count": 38, "cache_hit": true}');

-- ============================================================================
-- Seed Data: Mock Metrics
-- ============================================================================

-- Request count metrics
INSERT INTO metrics (name, value, timestamp, labels, type, unit) VALUES
('http_requests_total', 1245, NOW() - INTERVAL '2 hours', '{"service": "rdsuserdisplaycacheapi", "method": "GET", "endpoint": "/api/userdisplaycache/users", "status": "200"}', 'counter', 'requests'),
('http_requests_total', 42, NOW() - INTERVAL '1 hour 30 minutes', '{"service": "rdsuserdisplaycacheapi", "method": "GET", "endpoint": "/api/userdisplaycache/users", "status": "500"}', 'counter', 'requests'),
('http_requests_total', 28, NOW() - INTERVAL '1 hour', '{"service": "rdsuserdisplaycacheapi", "method": "GET", "endpoint": "/api/userdisplaycache/users", "status": "500"}', 'counter', 'requests'),
('http_requests_total', 892, NOW() - INTERVAL '30 minutes', '{"service": "rdsuserdisplaycacheapi", "method": "GET", "endpoint": "/api/userdisplaycache/users", "status": "200"}', 'counter', 'requests');

-- Error rate metrics (matching the 0.58 error rate from the alert)
INSERT INTO metrics (name, value, timestamp, labels, type, unit) VALUES
('error_rate', 0.02, NOW() - INTERVAL '3 hours', '{"service": "rdsuserdisplaycacheapi"}', 'gauge', 'ratio'),
('error_rate', 0.58, NOW() - INTERVAL '1 hour 30 minutes', '{"service": "rdsuserdisplaycacheapi"}', 'gauge', 'ratio'),
('error_rate', 0.45, NOW() - INTERVAL '1 hour', '{"service": "rdsuserdisplaycacheapi"}', 'gauge', 'ratio'),
('error_rate', 0.03, NOW() - INTERVAL '30 minutes', '{"service": "rdsuserdisplaycacheapi"}', 'gauge', 'ratio');

-- Response time metrics
INSERT INTO metrics (name, value, timestamp, labels, type, unit) VALUES
('http_request_duration_ms', 150, NOW() - INTERVAL '2 hours', '{"service": "rdsuserdisplaycacheapi", "endpoint": "/api/userdisplaycache/users", "status": "200"}', 'histogram', 'milliseconds'),
('http_request_duration_ms', 89, NOW() - INTERVAL '1 hour 30 minutes', '{"service": "rdsuserdisplaycacheapi", "endpoint": "/api/userdisplaycache/users", "status": "500"}', 'histogram', 'milliseconds'),
('http_request_duration_ms', 120, NOW() - INTERVAL '1 hour', '{"service": "rdsuserdisplaycacheapi", "endpoint": "/api/userdisplaycache/users", "status": "500"}', 'histogram', 'milliseconds'),
('http_request_duration_ms', 140, NOW() - INTERVAL '30 minutes', '{"service": "rdsuserdisplaycacheapi", "endpoint": "/api/userdisplaycache/users", "status": "200"}', 'histogram', 'milliseconds');

-- Pod/container metrics
INSERT INTO metrics (name, value, timestamp, labels, type, unit) VALUES
('container_cpu_usage', 0.45, NOW() - INTERVAL '1 hour 30 minutes', '{"pod": "rdsuserdisplaycacheapi-b54b998f4-xk7ql", "namespace": "rds-dev", "container": "rdsuserdisplaycacheapi"}', 'gauge', 'cores'),
('container_memory_usage_bytes', 524288000, NOW() - INTERVAL '1 hour 30 minutes', '{"pod": "rdsuserdisplaycacheapi-b54b998f4-xk7ql", "namespace": "rds-dev", "container": "rdsuserdisplaycacheapi"}', 'gauge', 'bytes'),
('pod_restart_count', 0, NOW() - INTERVAL '1 hour', '{"pod": "rdsuserdisplaycacheapi-b54b998f4-xk7ql", "namespace": "rds-dev"}', 'counter', 'restarts');

-- Database connection pool metrics
INSERT INTO metrics (name, value, timestamp, labels, type, unit) VALUES
('db_connection_pool_active', 8, NOW() - INTERVAL '1 hour 30 minutes', '{"service": "rdsuserdisplaycacheapi", "pool": "default"}', 'gauge', 'connections'),
('db_connection_pool_idle', 12, NOW() - INTERVAL '1 hour 30 minutes', '{"service": "rdsuserdisplaycacheapi", "pool": "default"}', 'gauge', 'connections'),
('db_query_duration_ms', 35, NOW() - INTERVAL '1 hour 30 minutes', '{"service": "rdsuserdisplaycacheapi", "query": "SELECT_UserCache"}', 'histogram', 'milliseconds');

-- Summary: Database now contains realistic traces, logs, and metrics simulating the ArgumentNullException error scenario
