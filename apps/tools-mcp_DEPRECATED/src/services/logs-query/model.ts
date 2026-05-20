/**
 * Logs Query Model
 * Defines the structure for DNN application log query operations
 */

export interface LogQueryRequest {
  query: string;
  timeout_ms?: number; // Query timeout in milliseconds (default: 30000)
}

export interface LogQueryResponse {
  success: boolean;
  row_count?: number;
  rows?: any[];
  error?: string;
  warning?: string; // Warnings about large result sets
  execution_time_ms?: number;
}

/**
 * DNN Application Log Record
 * Schema matches application_logs table created in migration 009
 */
export interface ApplicationLogRecord {
  id: number;
  timestamp: Date;
  host: string;        // DNN server hostname (e.g., N20-TR-PTLW002P)
  thread_id: string;   // Thread identifier (e.g., Thread:31)
  level: string;       // Log level: DEBUG, INFO, WARN, ERROR, FATAL
  logger: string;      // Logger name (e.g., DotNetNuke.Services.Exceptions.Exceptions)
  message: string;     // Log message (includes stack traces if present)
  stack_trace?: string; // Extracted stack trace if available
  file_path: string;   // Source log file path
  created_at: Date;    // Timestamp when log was ingested
}
