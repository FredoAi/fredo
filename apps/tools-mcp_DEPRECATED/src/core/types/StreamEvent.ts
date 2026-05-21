/**
 * Redis Streams Event System Types
 * 
 * Event-driven architecture for Fredo Tools MCP
 * Events flow: MCP Tools → Redis Streams → Stream Consumer → SSE → Browser Extension
 */

/**
 * Event lifecycle states
 */
export type EventState = 'Init' | 'Update' | 'Response' | 'Error';

/**
 * Base stream event structure
 */
export interface StreamEvent {
  // Core identification
  toolName: string;           // Name of the MCP tool that generated the event
  sessionId: string;          // Session ID to route to specific browser connection
  
  // Lifecycle state
  state: EventState;          // Current state of the event
  
  // State-specific payloads
  input?: any;                // Tool input parameters (included in 'Init' state)
  response?: any;             // Tool response data (included in 'Response' state)
  data?: string;              // Flexible JSON string for custom data (any state)
  
  // Metadata
  timestamp: string;          // ISO 8601 timestamp
  eventId?: string;           // Unique event identifier
  correlationId?: string;     // For tracking request chains across multiple events
  
  // Error handling
  error?: StreamEventError;   // Error details (included in 'Error' state)
}

/**
 * Error information for failed events
 */
export interface StreamEventError {
  message: string;            // Human-readable error message
  code?: string;              // Error code for programmatic handling
  stack?: string;             // Stack trace (development only)
  details?: any;              // Additional error context
}

/**
 * Redis Stream configuration
 */
export interface RedisStreamConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  streamKeyPattern: string;   // e.g., 'fredo:sessions:{sessionId}'
  maxLength?: number;         // Max events per stream (MAXLEN ~)
  ttl?: number;               // Time-to-live in seconds
}

/**
 * Stream publisher options
 */
export interface PublishOptions {
  sessionId: string;
  correlationId?: string;
  includeMetadata?: boolean;
}

/**
 * Stream consumer options
 */
export interface ConsumeOptions {
  sessionId?: string;         // Consume specific session or all
  block?: number;             // Block for N milliseconds
  count?: number;             // Max events per read
  lastId?: string;            // Resume from specific event ID
}

/**
 * Stream event with Redis metadata
 */
export interface RedisStreamEvent extends StreamEvent {
  redisId: string;            // Redis stream entry ID (e.g., '1706543210123-0')
  streamKey: string;          // Redis stream key where event was published
}
