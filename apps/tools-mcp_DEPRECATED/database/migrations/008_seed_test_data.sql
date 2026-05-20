-- Seed simple test data for query tool development and testing

-- Insert test logs
INSERT INTO logs (timestamp, level, message, service, operation, trace_id, span_id, metadata) VALUES
(NOW() - INTERVAL '10 minutes', 'error', 'Authentication failed for user', 'auth-api', 'login', 'trace-001', 'span-001', '{"userId": "12345"}'),
(NOW() - INTERVAL '15 minutes', 'error', 'Database connection timeout', 'user-api', 'getUserProfile', 'trace-002', 'span-002', '{"timeout": 5000}'),
(NOW() - INTERVAL '20 minutes', 'warn', 'High memory usage detected', 'worker-01', 'processQueue', 'trace-003', 'span-003', '{"memoryPercent": 85}'),
(NOW() - INTERVAL '30 minutes', 'error', 'Payment processing failed', 'payment-api', 'processPayment', 'trace-004', 'span-004', '{"amount": 99.99}'),
(NOW() - INTERVAL '45 minutes', 'info', 'User logged in successfully', 'auth-api', 'login', 'trace-005', 'span-005', '{"userId": "67890"}');

-- Insert test metrics
INSERT INTO metrics (name, value, timestamp, labels, type, unit) VALUES
('cpu_usage_percent', 45.2, NOW() - INTERVAL '5 minutes', '{"service": "api", "host": "server-01"}', 'gauge', 'percent'),
('cpu_usage_percent', 67.8, NOW() - INTERVAL '10 minutes', '{"service": "api", "host": "server-01"}', 'gauge', 'percent'),
('http_requests_total', 1523, NOW() - INTERVAL '5 minutes', '{"service": "api", "environment": "prod"}', 'counter', 'requests'),
('http_errors_total', 12, NOW() - INTERVAL '5 minutes', '{"service": "api", "environment": "prod"}', 'counter', 'errors'),
('memory_usage_bytes', 8589934592, NOW() - INTERVAL '10 minutes', '{"host": "server-02"}', 'gauge', 'bytes');

-- Insert test traces
INSERT INTO traces (trace_id, span_id, parent_span_id, operation_name, start_time, end_time, duration, status, tags) VALUES
('trace-001', 'span-001', NULL, 'POST /api/login', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes' + INTERVAL '150 milliseconds', 150000, 'error', '{"service.name": "auth-api", "http.method": "POST", "error": "true"}'),
('trace-002', 'span-002', NULL, 'GET /api/users/profile', NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '15 minutes' + INTERVAL '2500 milliseconds', 2500000, 'error', '{"service.name": "user-api", "http.method": "GET", "error": "true"}'),
('trace-003', 'span-003', NULL, 'POST /api/payment', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes' + INTERVAL '50 milliseconds', 50000, 'ok', '{"service.name": "payment-api", "http.method": "POST"}'),
('trace-004', 'span-004', NULL, 'SELECT users FROM database', NOW() - INTERVAL '25 minutes', NOW() - INTERVAL '25 minutes' + INTERVAL '800 milliseconds', 800000, 'ok', '{"service.name": "db-service", "span.kind": "client"}');
