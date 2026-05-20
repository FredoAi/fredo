-- Seed mock metrics data for rdsuserdisplaycacheapi error scenario
-- Simulates application metrics from WinSights DEV environment showing high error rate

-- Error rate metrics (counter type) - showing spike in errors
INSERT INTO metrics (name, value, timestamp, labels, type, unit) VALUES
-- Normal error rate (before spike)
('trace.aspnet.core.request.errors', 0.02, '2025-11-13 13:00:00'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

('trace.aspnet.core.request.errors', 0.03, '2025-11-13 13:30:00'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

-- Error spike begins
('trace.aspnet.core.request.errors', 0.5, '2025-11-13 14:00:00'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

('trace.aspnet.core.request.errors', 0.5, '2025-11-13 14:30:00'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

('trace.aspnet.core.request.errors', 0.5, '2025-11-13 15:00:00'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

('trace.aspnet.core.request.errors', 0.5, '2025-11-13 15:30:00'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

('trace.aspnet.core.request.errors', 0.5, '2025-11-13 16:00:00'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

('trace.aspnet.core.request.errors', 0.5, '2025-11-13 16:17:38'::timestamptz, 
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "iac": "pulumi", "product": "winsights", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb, 
'gauge', 'errors/sec'),

-- Request rate metrics
('http.server.requests', 120, '2025-11-13 13:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "status": "200", "method": "POST", "endpoint": "/api/userdisplaycache/userdisplay"}'::jsonb,
'counter', 'requests'),

('http.server.requests', 25, '2025-11-13 14:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "status": "500", "method": "POST", "endpoint": "/api/userdisplaycache/userdisplay"}'::jsonb,
'counter', 'requests'),

('http.server.requests', 115, '2025-11-13 14:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "status": "200", "method": "POST", "endpoint": "/api/userdisplaycache/userdisplay"}'::jsonb,
'counter', 'requests'),

-- Response time metrics (histogram)
('http.server.duration', 190.5, '2025-11-13 13:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "status": "200", "method": "POST"}'::jsonb,
'histogram', 'milliseconds'),

('http.server.duration', 22.3, '2025-11-13 14:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "status": "500", "method": "POST"}'::jsonb,
'histogram', 'milliseconds'),

('http.server.duration', 17.7, '2025-11-13 16:17:38'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "status": "500", "method": "POST"}'::jsonb,
'histogram', 'milliseconds'),

-- Memory metrics
('process.runtime.dotnet.gc.heap.size', 157286400, '2025-11-13 16:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp", "generation": "gen2"}'::jsonb,
'gauge', 'bytes'),

-- CPU metrics
('process.cpu.usage', 0.45, '2025-11-13 16:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "pod": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}'::jsonb,
'gauge', 'percent'),

-- Cache metrics
('cache.hits', 850, '2025-11-13 13:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "cache_name": "user_display_cache"}'::jsonb,
'counter', 'hits'),

('cache.misses', 45, '2025-11-13 13:00:00'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "cache_name": "user_display_cache"}'::jsonb,
'counter', 'misses'),

-- Exception metrics
('exceptions.count', 1, '2025-11-13 16:17:38'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "exception_type": "System.ArgumentNullException", "method": "GetTenantUsers"}'::jsonb,
'counter', 'exceptions'),

('exceptions.count', 1, '2025-11-13 14:22:15'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "exception_type": "System.ArgumentNullException", "method": "GetTenantUsers"}'::jsonb,
'counter', 'exceptions'),

('exceptions.count', 1, '2025-11-13 15:45:33'::timestamptz,
'{"service": "rdsuserdisplaycacheapi", "environment": "rds.dev", "exception_type": "System.ArgumentNullException", "method": "GetTenantUsers"}'::jsonb,
'counter', 'exceptions');

COMMENT ON TABLE metrics IS 'Mock metrics simulating WinSights RDS showing 50% error rate spike in rdsuserdisplaycacheapi';
