-- Seed mock traces data for rdsuserdisplaycacheapi error scenario
-- Simulates distributed tracing data from WinSights DEV environment

-- Successful request trace
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('2502482711967542834', '7f8a9b1c2d3e4f5g', NULL, 'EntryPoint_websecure_axis-dev.ehrcloud.com', '2025-11-13 16:17:38.326'::timestamptz, '2025-11-13 16:17:38.543'::timestamptz, 217000, 'ok', 
'{"service.name": "traefik", "http.method": "POST", "http.url": "/api/userdisplaycache/userdisplay", "http.status_code": 200, "component": "ingress", "environment": "rds.dev"}'),

('2502482711967542834', 'a1b2c3d4e5f6g7h8', '7f8a9b1c2d3e4f5g', 'forward_winsights-dev-rdsgatewayapi-base-ingress@kubernetes', '2025-11-13 16:17:38.330'::timestamptz, '2025-11-13 16:17:38.540'::timestamptz, 210000, 'ok',
'{"service.name": "traefik", "upstream.service": "winsights-dev-rdsgatewayapi", "kubernetes.namespace": "pulumi", "peer.address": "10.244.0.45:80"}'),

('2502482711967542834', 'b2c3d4e5f6g7h8i9', 'a1b2c3d4e5f6g7h8', 'POST /services/api/userdisplaycache/userdisplay', '2025-11-13 16:17:38.335'::timestamptz, '2025-11-13 16:17:38.535'::timestamptz, 200000, 'ok',
'{"service.name": "rdsuserdisplaycacheapi", "http.method": "POST", "http.route": "/api/userdisplaycache/userdisplay", "http.status_code": 200, "pod.name": "rdsuserdisplaycacheapi-b54b998f4-wz8xp", "node.name": "aks-e21nonprod-32448851-vmss000002"}'),

('2502482711967542834', 'c3d4e5f6g7h8i9j0', 'b2c3d4e5f6g7h8i9', 'POST /api/userdisplaycache/userdisplay', '2025-11-13 16:17:38.340'::timestamptz, '2025-11-13 16:17:38.530'::timestamptz, 190000, 'ok',
'{"service.name": "rdsuserdisplaycacheapi", "operation": "UserDisplayController.GetTenantUsers", "tenant.id": "ehrcloud", "cache.hit": true}');

-- Error trace - ArgumentNullException
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags, logs) VALUES
('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'x1y2z3a4b5c6d7e8', NULL, 'EntryPoint_websecure_axis-dev.ehrcloud.com', '2025-11-13 16:17:38.526'::timestamptz, '2025-11-13 16:17:38.556'::timestamptz, 30000, 'error',
'{"service.name": "traefik", "http.method": "POST", "http.url": "/api/userdisplaycache/userdisplay", "http.status_code": 500, "component": "ingress", "environment": "rds.dev", "error": true}',
'[{"timestamp": "2025-11-13T16:17:38.526Z", "level": "error", "message": "Request failed with status 500"}]'),

('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'y2z3a4b5c6d7e8f9', 'x1y2z3a4b5c6d7e8', 'forward_winsights-dev-rdsgatewayapi-base-ingress@kubernetes', '2025-11-13 16:17:38.528'::timestamptz, '2025-11-13 16:17:38.554'::timestamptz, 26000, 'error',
'{"service.name": "traefik", "upstream.service": "winsights-dev-rdsgatewayapi", "kubernetes.namespace": "pulumi", "peer.address": "10.244.0.45:80", "error": true}',
'[{"timestamp": "2025-11-13T16:17:38.554Z", "level": "error", "message": "Upstream service returned 500"}]'),

('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'z3a4b5c6d7e8f9g0', 'y2z3a4b5c6d7e8f9', 'POST /services/api/userdisplaycache/userdisplay', '2025-11-13 16:17:38.530'::timestamptz, '2025-11-13 16:17:38.552'::timestamptz, 22000, 'error',
'{"service.name": "rdsuserdisplaycacheapi", "http.method": "POST", "http.route": "/api/userdisplaycache/userdisplay", "http.status_code": 500, "pod.name": "rdsuserdisplaycacheapi-b54b998f4-wz8xp", "node.name": "aks-e21nonprod-32448851-vmss000002", "error": true, "exception.type": "System.ArgumentNullException"}',
'[{"timestamp": "2025-11-13T16:17:38.535Z", "level": "error", "message": "ArgumentNullException in GetTenantUsers", "stack": "System.ArgumentNullException: Value cannot be null. (Parameter ''tenantId'')\n   at WinSights.RDS.API.Controllers.UserDisplayController.GetTenantUsers(String tenantId)"}]'),

('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'a4b5c6d7e8f9g0h1', 'z3a4b5c6d7e8f9g0', 'POST /api/userdisplaycache/userdisplay', '2025-11-13 16:17:38.531'::timestamptz, '2025-11-13 16:17:38.550'::timestamptz, 19000, 'error',
'{"service.name": "rdsuserdisplaycacheapi", "operation": "UserDisplayController.GetTenantUsers", "tenant.id": null, "cache.hit": false, "error": true, "exception.type": "System.ArgumentNullException", "exception.message": "Value cannot be null. (Parameter tenantId)"}',
'[{"timestamp": "2025-11-13T16:17:38.535Z", "level": "error", "message": "Missing error message and stack trace"}]');

-- Additional error traces (simulating high error rate)
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('f1e2d3c4b5a69788970605040302010', 'e1f2g3h4i5j6k7l8', NULL, 'EntryPoint_websecure_axis-dev.ehrcloud.com', '2025-11-13 14:22:15.123'::timestamptz, '2025-11-13 14:22:15.145'::timestamptz, 22000, 'error',
'{"service.name": "traefik", "http.method": "POST", "http.status_code": 500, "error": true, "environment": "rds.dev"}'),

('f1e2d3c4b5a69788970605040302010', 'f2g3h4i5j6k7l8m9', 'e1f2g3h4i5j6k7l8', 'POST /services/api/userdisplaycache/userdisplay', '2025-11-13 14:22:15.125'::timestamptz, '2025-11-13 14:22:15.143'::timestamptz, 18000, 'error',
'{"service.name": "rdsuserdisplaycacheapi", "http.status_code": 500, "error": true, "exception.type": "System.ArgumentNullException", "pod.name": "rdsuserdisplaycacheapi-b54b998f4-5n7qm"}'),

('0a1b2c3d4e5f67890a1b2c3d4e5f6789', 'g3h4i5j6k7l8m9n0', NULL, 'EntryPoint_websecure_axis-dev.ehrcloud.com', '2025-11-13 15:45:33.456'::timestamptz, '2025-11-13 15:45:33.478'::timestamptz, 22000, 'error',
'{"service.name": "traefik", "http.method": "POST", "http.status_code": 500, "error": true, "environment": "rds.dev"}'),

('0a1b2c3d4e5f67890a1b2c3d4e5f6789', 'h4i5j6k7l8m9n0o1', 'g3h4i5j6k7l8m9n0', 'POST /services/api/userdisplaycache/userdisplay', '2025-11-13 15:45:33.458'::timestamptz, '2025-11-13 15:45:33.476'::timestamptz, 18000, 'error',
'{"service.name": "rdsuserdisplaycacheapi", "http.status_code": 500, "error": true, "exception.type": "System.ArgumentNullException", "pod.name": "rdsuserdisplaycacheapi-b54b998f4-wz8xp"}');

-- Successful traces for context
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('1234567890abcdef1234567890abcdef', 'i5j6k7l8m9n0o1p2', NULL, 'EntryPoint_websecure_axis-dev.ehrcloud.com', '2025-11-13 13:30:00.000'::timestamptz, '2025-11-13 13:30:00.250'::timestamptz, 250000, 'ok',
'{"service.name": "traefik", "http.method": "POST", "http.status_code": 200, "environment": "rds.dev"}'),

('1234567890abcdef1234567890abcdef', 'j6k7l8m9n0o1p2q3', 'i5j6k7l8m9n0o1p2', 'POST /services/api/userdisplaycache/userdisplay', '2025-11-13 13:30:00.005'::timestamptz, '2025-11-13 13:30:00.245'::timestamptz, 240000, 'ok',
'{"service.name": "rdsuserdisplaycacheapi", "http.status_code": 200, "cache.hit": true, "pod.name": "rdsuserdisplaycacheapi-b54b998f4-7k2pm"}');

COMMENT ON TABLE traces IS 'Mock traces simulating WinSights RDS error scenario - ArgumentNullException in rdsuserdisplaycacheapi';
