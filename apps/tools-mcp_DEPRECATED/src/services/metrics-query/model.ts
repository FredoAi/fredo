/**
 * Metrics Query Model
 * Defines the structure for metric query operations
 */

export interface MetricQueryRequest {
  query: string;
}

export interface MetricQueryResponse {
  success: boolean;
  row_count?: number;
  rows?: any[];
  error?: string;
}

export interface MetricRecord {
  id: number;
  name: string;
  value: number;
  timestamp: Date;
  labels: Record<string, any>;
  metric_type: 'counter' | 'gauge' | 'histogram' | 'summary';
  unit?: string;
  created_at: Date;
}
