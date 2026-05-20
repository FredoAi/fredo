/**
 * Redis Stream Consumer Service
 * 
 * Consumes events from Redis Streams and routes them to browser SSE connections
 * Handles event deserialization, session routing, and connection management
 */

import Redis from 'ioredis';
import { RedisStreamEvent, ConsumeOptions, RedisStreamConfig } from '../../core/types/StreamEvent.js';

export interface StreamConsumerCallbacks {
  onEvent: (event: RedisStreamEvent) => Promise<void>;
  onError?: (error: Error) => void;
}

export class StreamConsumer {
  private redis: Redis;
  private config: RedisStreamConfig;
  private isRunning: boolean = false;
  private consumeInterval?: NodeJS.Timeout;

  constructor(config: RedisStreamConfig) {
    this.config = config;
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
      lazyConnect: true,
    });

    this.redis.on('connect', () => {
      console.log('✅ StreamConsumer: Connected to Redis');
    });

    this.redis.on('error', (err) => {
      console.error('❌ StreamConsumer Redis error:', err);
    });
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  /**
   * Start consuming events from a specific session stream
   */
  async consumeSession(
    sessionId: string,
    callbacks: StreamConsumerCallbacks,
    options?: ConsumeOptions
  ): Promise<void> {
    const streamKey = this.getStreamKey(sessionId);
    const lastId = options?.lastId || '0'; // Start from beginning or specific ID

    console.log(`📥 StreamConsumer: Starting consumption for session ${sessionId}`);

    this.isRunning = true;

    let currentId = lastId;

    // Poll for new events
    while (this.isRunning) {
      try {
        const result = await (this.redis as any).xread(
          'COUNT',
          options?.count || 10,
          'BLOCK',
          options?.block || 1000, // Block for 1 second
          'STREAMS',
          streamKey,
          currentId
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (result && result.length > 0) {
          for (const [_stream, entries] of result) {
            for (const [id, fields] of entries) {
              const event = this.deserializeEvent(id, streamKey, fields);
              await callbacks.onEvent(event);
              currentId = id; // Update last processed ID
            }
          }
        }
      } catch (error) {
        console.error('❌ StreamConsumer error:', error);
        if (callbacks.onError) {
          callbacks.onError(error as Error);
        }
      }
    }
  }

  /**
   * Start consuming events from multiple session streams
   */
  async consumeMultipleSessions(
    sessionIds: string[],
    callbacks: StreamConsumerCallbacks,
    options?: ConsumeOptions
  ): Promise<void> {
    const streamKeys = sessionIds.map((id) => this.getStreamKey(id));
    const lastIds = sessionIds.map(() => options?.lastId || '0');

    console.log(`📥 StreamConsumer: Starting consumption for ${sessionIds.length} sessions`);

    this.isRunning = true;

    const currentIds = [...lastIds];

    while (this.isRunning) {
      try {
        // Build XREAD arguments for multiple streams
        const args: (string | number)[] = [
          'BLOCK',
          options?.block || 1000,
          'COUNT',
          options?.count || 10,
          'STREAMS',
          ...streamKeys,
          ...currentIds,
        ];

        const result = await (this.redis as any).xread(...args) as Array<[string, Array<[string, string[]]>]> | null;

        if (result && result.length > 0) {
          for (const [streamKey, entries] of result) {
            const streamIndex = streamKeys.indexOf(streamKey);
            
            for (const [id, fields] of entries) {
              const event = this.deserializeEvent(id, streamKey, fields);
              await callbacks.onEvent(event);
              currentIds[streamIndex] = id; // Update last processed ID for this stream
            }
          }
        }
      } catch (error) {
        console.error('❌ StreamConsumer error:', error);
        if (callbacks.onError) {
          callbacks.onError(error as Error);
        }
      }
    }
  }

  /**
   * Consume events via a Redis Consumer Group.
   * Phase 1: re-delivers any unACKed (pending) messages from previous connections.
   * Phase 2: blocks for new messages using offset '>'.
   * ACKs each message only after the onEvent callback resolves successfully.
   * If onEvent throws, the message is NOT acked and stays in the PEL for re-delivery.
   */
  async consumeSessionWithGroup(
    sessionId: string,
    groupName: string,
    consumerName: string,
    callbacks: StreamConsumerCallbacks,
    options?: ConsumeOptions
  ): Promise<void> {
    const streamKey = this.getStreamKey(sessionId);
    const count = options?.count || 10;
    const block = options?.block || 1000;

    console.log(`📥 StreamConsumer: Starting group consumption for session ${sessionId} (group: ${groupName})`);

    // Ensure consumer group exists (MKSTREAM creates the stream if needed)
    // Use '0' (not '$') so messages published before this consumer connected are visible.
    try {
      await (this.redis as any).call('XGROUP', 'CREATE', streamKey, groupName, '0', 'MKSTREAM');
    } catch (err: any) {
      if (!err.message?.includes('BUSYGROUP')) throw err;
    }

    this.isRunning = true;

    // ── Pre-Phase 1: steal any stale PEL messages held by a dead consumer.
    // Messages idle for >2s are considered abandoned (e.g. from a previous connection
    // whose MCP client closed before it could ack them).
    try {
      await (this.redis as any).call(
        'XAUTOCLAIM', streamKey, groupName, consumerName,
        '2000',  // min-idle-time ms
        '0-0',   // start from the beginning of the PEL
        'COUNT', '100'
      );
      console.log(`🔄 StreamConsumer: XAUTOCLAIM complete for session ${sessionId}`);
    } catch (err: any) {
      // XAUTOCLAIM requires Redis 6.2+ — ignore if not supported
      if (!err.message?.includes('unknown command') && !err.message?.includes('ERR')) {
        console.warn(`⚠️  StreamConsumer: XAUTOCLAIM failed (will use PEL as-is):`, err.message);
      }
    }

    // ── Phase 1: re-deliver pending (unACKed) messages from PEL ──
    let hasPending = true;
    while (this.isRunning && hasPending) {
      try {
        const pending = await (this.redis as any).call(
          'XREADGROUP', 'GROUP', groupName, consumerName,
          'COUNT', String(count),
          'STREAMS', streamKey, '0'
        ) as Array<[string, Array<[string, string[]]>]> | null;

        const entries = pending?.[0]?.[1] ?? [];
        if (entries.length === 0) { hasPending = false; break; }

        for (const [id, fields] of entries) {
          const event = this.deserializeEvent(id, streamKey, fields);
          try {
            await callbacks.onEvent(event);
            await (this.redis as any).call('XACK', streamKey, groupName, id);
          } catch (error) {
            // Leave in PEL — will be re-delivered on next connect
            if (callbacks.onError) callbacks.onError(error as Error);
          }
        }
      } catch (error) {
        if (!this.isRunning) { hasPending = false; break; }
        console.error('❌ StreamConsumer group PEL error:', error);
        if (callbacks.onError) callbacks.onError(error as Error);
        hasPending = false;
      }
    }

    // ── Phase 2: block for new messages ──
    while (this.isRunning) {
      try {
        const result = await (this.redis as any).call(
          'XREADGROUP', 'GROUP', groupName, consumerName,
          'BLOCK', String(block),
          'COUNT', String(count),
          'STREAMS', streamKey, '>'
        ) as Array<[string, Array<[string, string[]]>]> | null;

        const entries = result?.[0]?.[1] ?? [];
        for (const [id, fields] of entries) {
          const event = this.deserializeEvent(id, streamKey, fields);
          try {
            await callbacks.onEvent(event);
            await (this.redis as any).call('XACK', streamKey, groupName, id);
          } catch (error) {
            // Leave in PEL — will be re-delivered on next connect
            if (callbacks.onError) callbacks.onError(error as Error);
          }
        }
      } catch (error) {
        // Suppress errors that are caused by intentional disconnect (stop() was called)
        if (!this.isRunning) break;
        console.error('❌ StreamConsumer group error:', error);
        if (callbacks.onError) callbacks.onError(error as Error);
      }
    }
  }

  /**
   * Stop consuming events
   */
  stop(): void {
    console.log('⏹️  StreamConsumer: Stopping consumption');
    this.isRunning = false;
    if (this.consumeInterval) {
      clearInterval(this.consumeInterval);
    }
  }

  /**
   * Get stream key from session ID
   */
  private getStreamKey(sessionId: string): string {
    return this.config.streamKeyPattern.replace('{sessionId}', sessionId);
  }

  /**
   * Deserialize Redis stream entry to RedisStreamEvent
   */
  private deserializeEvent(redisId: string, streamKey: string, fields: string[]): RedisStreamEvent {
    const event: any = {
      redisId,
      streamKey,
    };

    // Parse field-value pairs
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];

      // Try to parse JSON for complex fields
      try {
        if (['input', 'response', 'error'].includes(key)) {
          event[key] = JSON.parse(value);
        } else if (key === 'data') {
          // data can be a JSON string or plain string
          event[key] = value;
        } else {
          event[key] = value;
        }
      } catch {
        // If JSON parse fails, use raw value
        event[key] = value;
      }
    }

    return event as RedisStreamEvent;
  }

  /**
   * Close Redis connection.
   * Uses disconnect() (immediate socket close) instead of quit() (graceful)
   * so any in-flight BLOCK XREADGROUP is interrupted right away, preventing
   * the zombie-consumer loop that endlessly re-delivers PEL messages.
   */
  async disconnect(): Promise<void> {
    this.stop();
    // disconnect() closes the socket immediately, which unblocks any XREADGROUP BLOCK call.
    // quit() sends QUIT to Redis and waits for OK — the blocked call would keep running
    // until the 1s block timeout expires, causing the zombie-loop seen in docker logs.
    this.redis.disconnect();
    console.log('StreamConsumer: Disconnected from Redis');
  }

  /**
   * Get Redis client for advanced operations
   */
  getClient(): Redis {
    return this.redis;
  }
}
