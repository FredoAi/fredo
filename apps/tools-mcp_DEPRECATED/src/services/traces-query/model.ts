/**
 * Traces Query Model
 * Defines the structure for trace query operations
 */

export interface TraceQueryRequest {
  query: string;
}

export interface TraceQueryResponse {
  success: boolean;
  row_count?: number;
  rows?: any[];
  error?: string;
}

export interface TraceRecord {
  id: number;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  operation_name: string;
  start_time: Date;
  end_time: Date;
  duration: number;
  status: 'ok' | 'error' | 'unset';
  tags: Record<string, any>;
  created_at: Date;
}
