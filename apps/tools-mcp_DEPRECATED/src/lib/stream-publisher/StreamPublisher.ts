/**
 * Redis Stream Publisher Service
 * 
 * Publishes events from MCP tools and API services to Redis Streams
 * Handles event serialization, stream key generation, and TTL management
 */

import Redis from 'ioredis';
import { StreamEvent, PublishOptions, RedisStreamConfig } from '../../core/types/StreamEvent.js';

// ── Embedded-mode override ────────────────────────────────────────────────── //
// In embedded (VS Code extension) mode without Redis, embedded.ts calls
// setEmbeddedPublisher(InMemoryStreamPublisher.getInstance()) so all
// StreamPublisher.getInstance() callers transparently get the in-memory impl.
let _embeddedPublisher: StreamPublisher | null = null;

export function setEmbeddedPublisher(publisher: StreamPublisher): void {
  _embeddedPublisher = publisher;
}

export class StreamPublisher {
  private static instance: StreamPublisher;
  private redis: Redis;
  private config: RedisStreamConfig;

  private constructor(config: RedisStreamConfig) {
    this.config = config;
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
      lazyConnect: true,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        console.log(`Redis reconnecting... attempt ${times}, delay ${delay}ms`);
        return delay;
      },
    });

    this.redis.on('connect', () => {
      console.log('✅ StreamPublisher: Connected to Redis');
    });

    this.redis.on('error', (err) => {
      console.error('❌ StreamPublisher Redis error:', err);
    });
  }

  /** Returns true if an instance (or embedded override) has already been created. */
  static hasInstance(): boolean {
    return !!(_embeddedPublisher ?? StreamPublisher.instance);
  }

  /**
   * Get singleton instance.
   * In embedded mode, returns whatever was registered via setEmbeddedPublisher()
   * (typically InMemoryStreamPublisher) instead of creating a Redis client.
   */
  static getInstance(config?: RedisStreamConfig): StreamPublisher {
    // Embedded override — avoids any Redis connection in VS Code extension mode
    if (_embeddedPublisher) return _embeddedPublisher;

    if (!StreamPublisher.instance) {
      if (!config) {
        throw new Error('StreamPublisher must be initialized with config on first call');
      }
      StreamPublisher.instance = new StreamPublisher(config);
    }
    return StreamPublisher.instance;
  }

  /**
   * Initialize connection to Redis
   */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  /**
   * Publish an event to Redis Stream
   */
  async publish(event: StreamEvent, options?: Partial<PublishOptions>): Promise<string> {
    try {
      const sessionId = options?.sessionId || event.sessionId;
      const streamKey = this.getStreamKey(sessionId);

      // Add metadata
      const enrichedEvent: StreamEvent = {
        ...event,
        sessionId,
        eventId: event.eventId || this.generateEventId(),
        timestamp: event.timestamp || new Date().toISOString(),
        correlationId: options?.correlationId || event.correlationId,
      };

      // Serialize event to Redis stream format
      const fields = this.serializeEvent(enrichedEvent);

      // Publish to stream with MAXLEN to prevent unbounded growth
      const eventId = await this.redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        this.config.maxLength || 1000,
        '*', // Auto-generate ID
        ...fields
      );

      // Set TTL on stream if configured
      if (this.config.ttl) {
        await this.redis.expire(streamKey, this.config.ttl);
      }

      // Broadcast to global dev-mode PubSub channel only if a dev-mode SSE client is connected.
      const { DevModeService } = await import('../../services/dev-mode/service.js');
      if (DevModeService.getInstance().listenerCount > 0) {
        await this.redis.publish('atlas:global:events', JSON.stringify(enrichedEvent));
      }

      console.log(`📤 Published event to ${streamKey}: ${enrichedEvent.toolName} [${enrichedEvent.state}]`);
      return eventId ?? '';
    } catch (error) {
      console.error('❌ Failed to publish event:', error);
      throw error;
    }
  }

  /**
   * Publish Init state event (when tool starts execution)
   */
  async publishInit(toolName: string, sessionId: string, input: any, correlationId?: string): Promise<string> {
    return this.publish({
      toolName,
      sessionId,
      state: 'Init',
      input,
      timestamp: new Date().toISOString(),
      correlationId,
    });
  }

  /**
   * Publish Update state event (progress updates during execution)
   */
  async publishUpdate(toolName: string, sessionId: string, data: any, correlationId?: string): Promise<string> {
    return this.publish({
      toolName,
      sessionId,
      state: 'Update',
      data: typeof data === 'string' ? data : JSON.stringify(data),
      timestamp: new Date().toISOString(),
      correlationId,
    });
  }

  /**
   * Publish Response state event (when tool completes successfully)
   */
  async publishResponse(toolName: string, sessionId: string, response: any, correlationId?: string): Promise<string> {
    return this.publish({
      toolName,
      sessionId,
      state: 'Response',
      response,
      timestamp: new Date().toISOString(),
      correlationId,
    });
  }

  /**
   * Publish Error state event (when tool fails)
   */
  async publishError(toolName: string, sessionId: string, error: Error, correlationId?: string): Promise<string> {
    return this.publish({
      toolName,
      sessionId,
      state: 'Error',
      error: {
        message: error.message,
        code: (error as any).code,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
      correlationId,
    });
  }

  /**
   * Generate stream key from session ID
   */
  private getStreamKey(sessionId: string): string {
    return this.config.streamKeyPattern.replace('{sessionId}', sessionId);
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Serialize StreamEvent to Redis stream field-value pairs
   */
  private serializeEvent(event: StreamEvent): string[] {
    const fields: string[] = [];

    // Add each field as key-value pair
    Object.entries(event).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        fields.push(key);
        fields.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    });

    return fields;
  }

  /**
   * Publish an event to the dev-mode PubSub channel only (no session stream write).
   * Skips silently if no dev-mode SSE client is currently connected.
   */
  async publishToDevMode(event: Partial<StreamEvent> & { toolName: string; state: string; sessionId: string }): Promise<void> {
    const { DevModeService } = await import('../../services/dev-mode/service.js');
    if (DevModeService.getInstance().listenerCount === 0) return;

    const enriched = {
      ...event,
      eventId: event.eventId || this.generateEventId(),
      timestamp: event.timestamp || new Date().toISOString(),
    };
    await this.redis.publish('atlas:global:events', JSON.stringify(enriched));
  }

  /**
   * Close Redis connection
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
    console.log('StreamPublisher: Disconnected from Redis');
  }

  /**
   * Get Redis client for advanced operations
   */
  getClient(): Redis {
    return this.redis;
  }
}
