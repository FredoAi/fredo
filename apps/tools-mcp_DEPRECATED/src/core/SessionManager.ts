import { randomUUID } from 'node:crypto';
import { FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { StreamConsumer } from '../lib/stream-consumer/StreamConsumer.js';
import { RedisStreamEvent, RedisStreamConfig } from './types/StreamEvent.js';

/**
 * Session data structure
 */
interface Session {
  id: string;
  connectionId: string;
  keyId: number;
  extensionVersion?: string;
  capabilities?: string[];
  metadata?: Record<string, any>;
  createdAt: Date;
  lastActivity: Date;
  isActive: boolean;
  sseReply?: FastifyReply;
  streamConsumer?: StreamConsumer;
  lastEventId?: string; // Last consumed Redis event ID
  sseConnectionPromise?: Promise<void>; // Promise that resolves when SSE connects
  sseConnectionResolve?: () => void; // Resolver for the promise
}

/**
 * SessionManager - Manages active SSE sessions and Redis Stream consumers
 * Integrates with Redis Streams for event-driven communication
 */
export class SessionManager {
  private static instance: SessionManager;
  private sessions: Map<string, Session> = new Map();
  private currentSessionId: string | undefined;
  private cleanupInterval?: NodeJS.Timeout;
  private redisConfig?: RedisStreamConfig;
  private redis: Redis | null = null;
  
  // Stores active connectionIds per keyId — persisted in Redis so they survive server restarts
  private activeConnectionIds: Map<number, string> = new Map();
  private static activeConnectionKey(keyId: number): string { return `fredo:active-connection:${keyId}`; }

  private constructor() {
    // Cleanup expired sessions every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000);
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Initialize with Redis configuration
   */
  initializeRedis(config: RedisStreamConfig): void {
    this.redisConfig = config;
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
    });
    this.redis.on('error', (err) => {
      console.error('❌ SessionManager Redis error:', err);
    });
    console.log('✅ SessionManager: Redis configuration initialized');
  }

  /**
   * Return the active connectionId, creating a new session if none exists.
   * Creates the Redis consumer group immediately so events published before
   * the browser opens its SSE stream land in the pending-entry list.
   */
  async getOrCreateActiveSession(keyId: number = 0): Promise<string> {
    // Always read from Redis first — the API server's SSE alignment may have updated
    // it after this process started (cross-process sync via Redis).
    if (this.redis) {
      const latest = await this.redis.get(SessionManager.activeConnectionKey(keyId));
      if (latest) {
        if (latest !== this.activeConnectionIds.get(keyId)) {
          console.log(`♻️  SessionManager: Updated activeConnectionId[${keyId}] from ${this.activeConnectionIds.get(keyId) ?? 'none'} → ${latest}`);
          this.activeConnectionIds.set(keyId, latest);
        }
        if (!this.sessions.has(latest)) {
          await this.createSession({ connectionId: latest, keyId });
        }
        return latest;
      }
    }

    const existing = this.activeConnectionIds.get(keyId);
    if (existing) {
      return existing;
    }

    const connectionId = randomUUID();
    await this.createSession({ connectionId, keyId });

    // Create consumer group upfront so any published events are buffered
    if (this.redis) {
      const streamKey = `fredo:sessions:${connectionId}:events`;
      try {
        await (this.redis as any).call('XGROUP', 'CREATE', streamKey, 'fredo-ui', '$', 'MKSTREAM');
        console.log(`📦 SessionManager: Consumer group created for ${connectionId}`);
      } catch (err: any) {
        // BUSYGROUP means the group already exists — safe to ignore
        if (!err.message?.includes('BUSYGROUP')) throw err;
      }
    }

    return connectionId;
  }

  /**
   * Returns true only when the given connection has a live, non-destroyed SSE reply.
   */
  hasActiveSSEConnection(connectionId: string): boolean {
    const session = this.sessions.get(connectionId);
    if (!session?.sseReply) return false;
    return !session.sseReply.raw.destroyed;
  }

  /**
   * Create a new session
   */
  async createSession(data: {
    connectionId: string;
    keyId?: number;
    extensionVersion?: string;
    capabilities?: string[];
    metadata?: Record<string, any>;
  }): Promise<Session> {
    // Create promise that will be resolved when SSE connection is established
    let resolveSSEConnection: () => void;
    const sseConnectionPromise = new Promise<void>((resolve) => {
      resolveSSEConnection = resolve;
    });

    const keyId = data.keyId ?? 0;

    const session: Session = {
      id: randomUUID(),
      connectionId: data.connectionId,
      keyId,
      extensionVersion: data.extensionVersion,
      capabilities: data.capabilities,
      metadata: data.metadata,
      createdAt: new Date(),
      lastActivity: new Date(),
      isActive: true,
      sseConnectionPromise,
      sseConnectionResolve: resolveSSEConnection!,
    };

    this.sessions.set(data.connectionId, session);
    this.currentSessionId = data.connectionId;
    
    // CRITICAL: Set active connectionId for this user's key
    // Subsequent kubectl tool calls will use this connectionId
    this.activeConnectionIds.set(keyId, data.connectionId);
    console.log(`⚡ SessionManager: Active connectionId[${keyId}] set to ${data.connectionId}`);

    // Persist to Redis so it survives server restarts
    if (this.redis) {
      await this.redis.set(SessionManager.activeConnectionKey(keyId), data.connectionId, 'EX', 3600);
    }

    console.log(`✅ SessionManager: Created session ${session.id} for connection ${data.connectionId}`);
    return session;
  }

  /**
   * Register a new session (backward compatibility)
   */
  registerSession(sessionId: string): void {
    console.error(`[SessionManager] Registering session: ${sessionId}`);
    
    const existingSession = this.sessions.get(sessionId);
    if (existingSession) {
      existingSession.lastActivity = new Date();
      existingSession.isActive = true;
    } else {
      const session: Session = {
        id: randomUUID(),
        connectionId: sessionId,
        keyId: 0,
        createdAt: new Date(),
        lastActivity: new Date(),
        isActive: true,
      };
      this.sessions.set(sessionId, session);
    }
    
    this.currentSessionId = sessionId;
  }

  /**
   * Wait for SSE connection to be established (for handshake tool)
   */
  async waitForSSEConnection(connectionId: string, timeoutMs: number = 30000): Promise<boolean> {
    const session = this.sessions.get(connectionId);
    if (!session) {
      throw new Error(`Session not found: ${connectionId}`);
    }

    if (!session.sseConnectionPromise) {
      console.warn(`⚠️  SessionManager: No SSE connection promise for ${connectionId}`);
      return false;
    }

    console.log(`⏳ SessionManager: Waiting for SSE connection (timeout: ${timeoutMs}ms)...`);
    
    try {
      // Race between SSE connection and timeout
      await Promise.race([
        session.sseConnectionPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('SSE connection timeout')), timeoutMs)
        )
      ]);
      console.log(`✅ SessionManager: SSE connection established`);
      return true;
    } catch (error) {
      console.error(`❌ SessionManager: SSE connection timeout after ${timeoutMs}ms`);
      return false;
    }
  }

  /**
   * Get the active connectionId (set by handshake, used by kubectl tools)
   * This allows tools called after handshake to publish to the same stream
   * even though they have different MCP session IDs
   */
  getActiveConnectionId(keyId: number = 0): string | undefined {
    return this.activeConnectionIds.get(keyId);
  }

  /**
   * Read active connectionId for a key directly from Redis (used by polling endpoint).
   */
  async getActiveConnectionIdForKey(keyId: number): Promise<string | null> {
    if (this.redis) {
      return await this.redis.get(SessionManager.activeConnectionKey(keyId));
    }
    return this.activeConnectionIds.get(keyId) ?? null;
  }
  
  /**
   * Clear active connectionId (useful for testing)
   */
  clearActiveConnectionId(keyId: number = 0): void {
    const prev = this.activeConnectionIds.get(keyId);
    this.activeConnectionIds.delete(keyId);
    console.log(`🗑️ SessionManager: Cleared active connectionId[${keyId}] (was: ${prev})`);
  }

  /**
   * Get session by connection ID
   */
  async getSession(connectionId: string): Promise<Session | undefined> {
    return this.sessions.get(connectionId);
  }

  /**
   * Register SSE connection and start Redis Stream consumer
   */
  async registerSSEConnection(connectionId: string, reply: FastifyReply, keyId: number = 0): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session) {
      throw new Error(`Session not found: ${connectionId}`);
    }

    session.sseReply = reply;
    session.isActive = true;   // Restore after closeSession may have set it false on prior disconnect
    session.lastActivity = new Date();

    // Browser is source of truth — align server's activeConnectionId to what it connected with.
    // This handles the case where the server auto-generated a different UUID before SSE opened.
    if (this.activeConnectionIds.get(keyId) !== connectionId) {
      console.log(`🔄 SessionManager: Aligning activeConnectionId[${keyId}] ${this.activeConnectionIds.get(keyId)} → ${connectionId}`);
      this.activeConnectionIds.set(keyId, connectionId);
      if (this.redis) {
        await this.redis.set(SessionManager.activeConnectionKey(keyId), connectionId, 'EX', 3600);
      }
    }

    // Start Redis Stream consumer for this session
    if (this.redisConfig) {
      await this.startStreamConsumer(session);
    }

    // Resolve the SSE connection promise to unblock the handshake tool
    if (session.sseConnectionResolve) {
      console.log(`🔓 SessionManager: Resolving SSE connection promise for ${connectionId}`);
      session.sseConnectionResolve();
    }

    console.log(`📡 SessionManager: SSE connection registered for session ${connectionId}`);
  }

  /**
   * Start Redis Stream consumer for a session using a consumer group.
   * On reconnect, pending (unACKed) messages are re-delivered first.
   */
  private async startStreamConsumer(session: Session): Promise<void> {
    if (!this.redisConfig) {
      console.warn('⚠️  SessionManager: Redis config not initialized, skipping stream consumer');
      return;
    }

    const consumer = new StreamConsumer(this.redisConfig);
    await consumer.connect();

    session.streamConsumer = consumer;

    // Use consumer groups so unACKed messages survive SSE disconnects
    consumer.consumeSessionWithGroup(
      session.connectionId,
      'fredo-ui',
      session.connectionId, // consumer name = connectionId (one consumer per group)
      {
        onEvent: async (event: RedisStreamEvent) => {
          // Throws on write failure → consumer will NOT ack → message stays in PEL
          await this.routeEventToSSE(session, event);
          session.lastEventId = event.redisId;
        },
        onError: (error: Error) => {
          console.error(`❌ StreamConsumer error for session ${session.connectionId}:`, error);
        },
      },
      {
        block: 1000,
        count: 10,
      }
    ).catch((err) => {
      console.error(`❌ StreamConsumer group failed for session ${session.connectionId}:`, err);
    });

    console.log(`📥 SessionManager: Stream consumer (group) started for session ${session.connectionId}`);
  }

  /**
   * Route Redis Stream event to SSE connection.
   * Throws on failure so the consumer group does NOT ack the message,
   * leaving it in the pending-entry list for re-delivery on reconnect.
   */
  private async routeEventToSSE(session: Session, event: RedisStreamEvent): Promise<void> {
    if (!session.sseReply || !session.isActive || session.sseReply.raw.destroyed) {
      throw new Error(`Session ${session.connectionId} has no active SSE connection`);
    }

    // Remove Redis metadata before sending to browser
    const { redisId, streamKey, ...browserEvent } = event;
    
    session.sseReply.raw.write(`data: ${JSON.stringify(browserEvent)}\n\n`);
    session.lastActivity = new Date();
    
    console.log(`📤 SessionManager: Routed ${event.toolName} [${event.state}] to session ${session.connectionId}`);
  }

  /**
   * Update session activity timestamp
   */
  async updateActivity(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  /**
   * Close a session
   */
  async closeSession(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    session.isActive = false;
    session.sseReply = undefined;

    // Stop stream consumer
    if (session.streamConsumer) {
      await session.streamConsumer.disconnect();
      session.streamConsumer = undefined;
    }

    console.log(`🔌 SessionManager: Session ${connectionId} closed`);

    // Keep session in memory for 1 hour for potential reconnection
    setTimeout(() => {
      this.sessions.delete(connectionId);
      console.log(`🗑️  SessionManager: Session ${connectionId} removed from memory`);
    }, 60 * 60 * 1000);
  }

  /**
   * Unregister a session (backward compatibility)
   */
  unregisterSession(sessionId: string): void {
    console.error(`[SessionManager] Unregistering session: ${sessionId}`);
    this.closeSession(sessionId);
    
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = undefined;
    }
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = new Date();
    const expireTime = 24 * 60 * 60 * 1000; // 24 hours

    for (const [connectionId, session] of this.sessions.entries()) {
      const timeSinceActivity = now.getTime() - session.lastActivity.getTime();
      if (timeSinceActivity > expireTime) {
        this.closeSession(connectionId);
      }
    }
  }

  /**
   * Get the current active session ID
   * Returns the most recently registered session
   */
  getCurrentSessionId(): string | undefined {
    console.error(`[SessionManager] getCurrentSessionId called, returning: ${this.currentSessionId}`);
    console.error(`[SessionManager] Active sessions: ${JSON.stringify(Array.from(this.sessions.keys()))}`);
    return this.currentSessionId;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.isActive)
      .map((s) => s.connectionId);
  }

  /**
   * Get all sessions (active and inactive)
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Shutdown - cleanup all sessions
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    for (const [connectionId] of this.sessions.entries()) {
      await this.closeSession(connectionId);
    }

    console.log('SessionManager: Shutdown complete');
  }
}
