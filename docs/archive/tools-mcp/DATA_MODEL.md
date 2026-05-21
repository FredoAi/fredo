# Fredo - Data Model Specification

## 🗂️ Core Framework Data Models

### ToolMetadata Interface

```typescript
interface ToolMetadata {
  /** Unique identifier for the tool */
  name: string;
  
  /** Human-readable description of tool functionality */
  description: string;
  
  /** Service that owns this tool */
  service: string;
  
  /** Tool version for compatibility tracking */
  version: string;
  
  /** JSON Schema for input parameters */
  parameters: JSONSchema7;
  
  /** JSON Schema for return type */
  returnType: JSONSchema7;
  
  /** Optional category for tool organization */
  category?: string;
  
  /** Example usage patterns */
  examples?: ToolExample[];
  
  /** Tags for discovery and filtering */
  tags?: string[];
  
  /** Estimated execution time in milliseconds */
  estimatedDuration?: number;
}
```

### ToolExample Interface

```typescript
interface ToolExample {
  /** Example description */
  name: string;
  
  /** Example input parameters */
  input: Record<string, unknown>;
  
  /** Expected output structure */
  output: Record<string, unknown>;
  
  /** Use case description */
  description: string;
}
```

### ServiceConfig Interface

```typescript
interface ServiceConfig {
  /** Service unique identifier */
  name: string;
  
  /** Service version */
  version: string;
  
  /** Service description */
  description: string;
  
  /** List of service dependencies */
  dependencies: string[];
  
  /** Service-specific configuration */
  config: Record<string, unknown>;
  
  /** Database connection requirements */
  database?: DatabaseRequirement;
  
  /** External API requirements */
  externalApis?: ExternalApiRequirement[];
}
```

### ValidationResult Interface

```typescript
interface ValidationResult {
  /** Whether validation passed */
  isValid: boolean;
  
  /** Validation error messages */
  errors: ValidationError[];
  
  /** Sanitized and transformed parameters */
  sanitizedParams?: Record<string, unknown>;
}

interface ValidationError {
  /** Parameter path (e.g., "filters.startTime") */
  path: string;
  
  /** Error message */
  message: string;
  
  /** Expected type or format */
  expected?: string;
  
  /** Actual received value */
  received?: unknown;
}
```

## 📊 Observability Data Models (OpenTelemetry)

### Trace Data Model

```typescript
interface Trace {
  /** Unique trace identifier */
  traceId: string;
  
  /** All spans in this trace */
  spans: Span[];
  
  /** Trace start time */
  startTime: Date;
  
  /** Trace end time */
  endTime: Date;
  
  /** Total trace duration in milliseconds */
  duration: number;
  
  /** Root service name */
  serviceName: string;
  
  /** Trace status (OK, ERROR, TIMEOUT) */
  status: TraceStatus;
}

interface Span {
  /** Unique span identifier */
  spanId: string;
  
  /** Parent span ID (null for root span) */
  parentSpanId: string | null;
  
  /** Trace this span belongs to */
  traceId: string;
  
  /** Operation name */
  operationName: string;
  
  /** Service that generated this span */
  serviceName: string;
  
  /** Span start time */
  startTime: Date;
  
  /** Span end time */
  endTime: Date;
  
  /** Span duration in milliseconds */
  duration: number;
  
  /** Span status */
  status: SpanStatus;
  
  /** Key-value attributes */
  attributes: Record<string, string | number | boolean>;
  
  /** Span events (logs within span) */
  events: SpanEvent[];
  
  /** Links to other spans */
  links: SpanLink[];
}

interface SpanEvent {
  /** Event timestamp */
  timestamp: Date;
  
  /** Event name */
  name: string;
  
  /** Event attributes */
  attributes: Record<string, string | number | boolean>;
}

interface SpanLink {
  /** Linked trace ID */
  traceId: string;
  
  /** Linked span ID */
  spanId: string;
  
  /** Link attributes */
  attributes: Record<string, string | number | boolean>;
}

enum TraceStatus {
  OK = 'OK',
  ERROR = 'ERROR', 
  TIMEOUT = 'TIMEOUT'
}

enum SpanStatus {
  OK = 'OK',
  ERROR = 'ERROR',
  CANCELLED = 'CANCELLED'
}
```

### Metrics Data Model

```typescript
interface Metric {
  /** Metric name */
  name: string;
  
  /** Metric description */
  description: string;
  
  /** Metric type */
  type: MetricType;
  
  /** Metric unit */
  unit: string;
  
  /** Data points */
  dataPoints: MetricDataPoint[];
  
  /** Resource attributes */
  resource: ResourceAttributes;
}

interface MetricDataPoint {
  /** Timestamp for this data point */
  timestamp: Date;
  
  /** Metric value */
  value: number | HistogramValue;
  
  /** Labels for this data point */
  labels: Record<string, string>;
  
  /** Exemplar (optional) */
  exemplar?: Exemplar;
}

interface HistogramValue {
  /** Histogram buckets */
  buckets: HistogramBucket[];
  
  /** Total count */
  count: number;
  
  /** Sum of all values */
  sum: number;
}

interface HistogramBucket {
  /** Upper bound of bucket */
  upperBound: number;
  
  /** Count of values in bucket */
  count: number;
}

interface Exemplar {
  /** Trace ID associated with this exemplar */
  traceId: string;
  
  /** Span ID associated with this exemplar */
  spanId: string;
  
  /** Timestamp */
  timestamp: Date;
  
  /** Value */
  value: number;
}

enum MetricType {
  COUNTER = 'COUNTER',
  GAUGE = 'GAUGE',
  HISTOGRAM = 'HISTOGRAM'
}
```

### Logs Data Model

```typescript
interface LogEntry {
  /** Unique log entry ID */
  id: string;
  
  /** Log timestamp */
  timestamp: Date;
  
  /** Log severity level */
  severity: LogSeverity;
  
  /** Log message */
  message: string;
  
  /** Service that generated the log */
  serviceName: string;
  
  /** Associated trace ID (if any) */
  traceId?: string;
  
  /** Associated span ID (if any) */
  spanId?: string;
  
  /** Structured attributes */
  attributes: Record<string, string | number | boolean>;
  
  /** Resource attributes */
  resource: ResourceAttributes;
  
  /** Log body (structured data) */
  body?: Record<string, unknown>;
}

enum LogSeverity {
  TRACE = 1,
  DEBUG = 5,
  INFO = 9,
  WARN = 13,
  ERROR = 17,
  FATAL = 21
}

interface ResourceAttributes {
  /** Service name */
  'service.name': string;
  
  /** Service version */
  'service.version'?: string;
  
  /** Service namespace */
  'service.namespace'?: string;
  
  /** Service instance ID */
  'service.instance.id'?: string;
  
  /** Additional resource attributes */
  [key: string]: string | undefined;
}
```

## 🔧 Azure DevOps Data Models

### WIQL Query Models

```typescript
interface WiqlQuery {
  /** WIQL query string */
  query: string;
  
  /** Maximum number of results to return */
  maxResults?: number;
  
  /** Skip first N results */
  skip?: number;
  
  /** Include work item fields in response */
  includeFields?: string[];
}

interface WiqlResult {
  /** Query execution metadata */
  metadata: WiqlQueryMetadata;
  
  /** Work items returned by query */
  workItems: WorkItem[];
  
  /** Total count of matching work items */
  totalCount: number;
  
  /** Whether there are more results available */
  hasMore: boolean;
}

interface WiqlQueryMetadata {
  /** Query execution time in milliseconds */
  executionTime: number;
  
  /** Number of work items returned */
  itemCount: number;
  
  /** Query that was executed */
  query: string;
  
  /** Timestamp when query was executed */
  executedAt: Date;
}
```

### Work Item Models

```typescript
interface WorkItem {
  /** Work item ID */
  id: number;
  
  /** Work item type (Bug, Task, User Story, etc.) */
  type: string;
  
  /** Current state (New, Active, Resolved, etc.) */
  state: string;
  
  /** Work item title */
  title: string;
  
  /** Work item description */
  description?: string;
  
  /** Assigned to user */
  assignedTo?: User;
  
  /** Created by user */
  createdBy: User;
  
  /** Creation date */
  createdDate: Date;
  
  /** Last modified date */
  modifiedDate: Date;
  
  /** Work item priority */
  priority?: number;
  
  /** Work item severity */
  severity?: string;
  
  /** Area path */
  areaPath: string;
  
  /** Iteration path */
  iterationPath: string;
  
  /** Work item tags */
  tags?: string[];
  
  /** Custom fields */
  customFields: Record<string, unknown>;
  
  /** Work item relations */
  relations?: WorkItemRelation[];
}

interface User {
  /** User display name */
  displayName: string;
  
  /** User email */
  email: string;
  
  /** User unique identifier */
  uniqueName: string;
  
  /** User ID */
  id: string;
}

interface WorkItemRelation {
  /** Relation type (Child, Parent, Related, etc.) */
  relationType: string;
  
  /** Related work item ID */
  targetId: number;
  
  /** Relation attributes */
  attributes: Record<string, string>;
}
```

## 📝 Query Parameter Models

### Common Query Parameters

```typescript
interface TimeRangeFilter {
  /** Start time (ISO 8601) */
  startTime: string;
  
  /** End time (ISO 8601) */
  endTime: string;
  
  /** Relative time range (e.g., "1h", "24h", "7d") */
  relativeTime?: string;
}

interface PaginationParams {
  /** Maximum number of results */
  limit: number;
  
  /** Number of results to skip */
  offset: number;
  
  /** Cursor-based pagination token */
  cursor?: string;
}

interface SortingParams {
  /** Field to sort by */
  sortBy: string;
  
  /** Sort direction */
  sortOrder: 'asc' | 'desc';
}
```

### Service-Specific Query Parameters

```typescript
// Traces Service
interface TracesQueryParams extends TimeRangeFilter, PaginationParams, SortingParams {
  /** Filter by service name */
  serviceName?: string;
  
  /** Filter by operation name */
  operationName?: string;
  
  /** Minimum duration in milliseconds */
  minDuration?: number;
  
  /** Maximum duration in milliseconds */
  maxDuration?: number;
  
  /** Filter by trace status */
  status?: TraceStatus[];
  
  /** Filter by span attributes */
  attributes?: Record<string, string>;
}

// Metrics Service
interface MetricsQueryParams extends TimeRangeFilter {
  /** Metric name pattern */
  metricName: string;
  
  /** Label filters */
  labels?: Record<string, string>;
  
  /** Aggregation function */
  aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count';
  
  /** Group by labels */
  groupBy?: string[];
  
  /** Time bucket size for aggregation */
  bucketSize?: string;
}

// Logs Service
interface LogsQueryParams extends TimeRangeFilter, PaginationParams, SortingParams {
  /** Filter by service name */
  serviceName?: string;
  
  /** Filter by severity level */
  severity?: LogSeverity[];
  
  /** Full-text search in message */
  messageSearch?: string;
  
  /** Filter by trace ID */
  traceId?: string;
  
  /** Filter by attributes */
  attributes?: Record<string, string>;
}

// Azure DevOps Service
interface AzDoQueryParams {
  /** Azure DevOps organization */
  organization: string;
  
  /** Azure DevOps project */
  project: string;
  
  /** WIQL query string */
  wiql: string;
  
  /** Maximum results */
  maxResults?: number;
  
  /** Include work item details */
  includeDetails?: boolean;
}
```

## 🔒 Security and Validation Models

### Authentication Models

```typescript
interface ApiCredentials {
  /** Credential type */
  type: 'bearer' | 'basic';
  
  /** Token or key value */
  value: string;
  
  /** Optional additional parameters */
  parameters?: Record<string, string>;
}

interface DatabaseCredentials {
  /** Database host */
  host: string;
  
  /** Database port */
  port: number;
  
  /** Database name */
  database: string;
  
  /** Username */
  username: string;
  
  /** Password */
  password: string;
  
  /** SSL configuration */
  ssl?: boolean;
}
```

### Error Models

```typescript
interface ApiError {
  /** Error code */
  code: string;
  
  /** Human-readable error message */
  message: string;
  
  /** Additional error details */
  details?: Record<string, unknown>;
  
  /** HTTP status code */
  statusCode: number;
  
  /** Error timestamp */
  timestamp: Date;
  
  /** Request ID for tracking */
  requestId?: string;
}
```