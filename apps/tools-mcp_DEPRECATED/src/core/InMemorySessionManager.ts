/**
 * InMemorySessionManager — Map-backed session manager
 *
 * Replaces the Redis-backed SessionManager when running embedded inside
 * the VS Code extension host.  Sessions are stored in process memory and
 * SSE events are delivered via InMemoryStreamPublisher's EventEmitter — no
 * Redis Streams, no consumer groups, no external process required.
 *
 * Public API is intentionally compatible with SessionManager so the Fastify
 * routes (session.ts, sse.ts) can call both interchangeably.
 */

import { randomUUID } from 'node:crypto';
import { FastifyReply } from 'fastify';
import { InMemoryStreamPublisher } from '../lib/stream-publisher/InMemoryStreamPublisher.js';
import type { StreamEvent } from './types/StreamEvent.js';

interface InMemorySession {
  id: string;
  connectionId: string;
  keyId: number;
  createdAt: Date;
  lastActivity: Date;
  isActive: boolean;
  sseReply?: FastifyReply;
  unsubscribe?: () => void;          // Unsubscribes from InMemoryStreamPublisher
  sseConnectionPromise: Promise<void>;
  sseConnectionResolve: () => void;
}

export class InMemorySessionManager {
  private static _instance: InMemorySessionManager | undefined;

  private readonly sessions = new Map<string, InMemorySession>();
  private readonly activeConnectionIds = new Map<number, string>();
  private currentSessionId: string | undefined;
  private cleanupInterval: NodeJS.Timeout;

  private constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
  }

  /** Get or create the singleton */
  static getInstance(): InMemorySessionManager {
    if (!InMemorySessionManager._instance) {
      InMemorySessionManager._instance = new InMemorySessionManager();
    }
    return InMemorySessionManager._instance;
  }

  /** Reset singleton (for testing or server restart) */
  static reset(): void {
    InMemorySessionManager._instance = undefined;
  }

  // ------------------------------------------------------------------ //
  // Core session management (matches SessionManager public API)
  // ------------------------------------------------------------------ //

  /**
   * Return the active connectionId for a keyId, creating a new session if none.
   */
  async getOrCreateActiveSession(keyId = 0): Promise<string> {
    const existing = this.activeConnectionIds.get(keyId);
    if (existing && this.sessions.has(existing)) {
      return existing;
    }
    const connectionId = randomUUID();
    await this.createSession({ connectionId, keyId });
    return connectionId;
  }

  /**
   * Create a new session record.
   */
  async createSession(data: {
    connectionId: string;
    keyId?: number;
    metadata?: Record<string, unknown>;
  }): Promise<InMemorySession> {
    let resolveSSEConnection!: () => void;
    const sseConnectionPromise = new Promise<void>((resolve) => {
      resolveSSEConnection = resolve;
    });

    const keyId = data.keyId ?? 0;
    const session: InMemorySession = {
      id: randomUUID(),
      connectionId: data.connectionId,
      keyId,
      createdAt: new Date(),
      lastActivity: new Date(),
      isActive: true,
      sseConnectionPromise,
      sseConnectionResolve: resolveSSEConnection,
    };

    this.sessions.set(data.connectionId, session);
    this.currentSessionId = data.connectionId;
    this.activeConnectionIds.set(keyId, data.connectionId);

    console.log(`✅ InMemorySessionManager: Created session for connection ${data.connectionId}`);
    return session;
  }

  /**
   * Register an SSE reply and start routing in-memory events to it.
   * Called when the browser opens its SSE stream.
   */
  async registerSSEConnection(
    connectionId: string,
    reply: FastifyReply,
    keyId = 0,
  ): Promise<void> {
    let session = this.sessions.get(connectionId);
    if (!session) {
      // Auto-create so reconnects work without a prior createSession call
      session = await this.createSession({ connectionId, keyId });
    }

    // If the browser connected with a different connectionId than we generated,
    // align activeConnectionIds to the browser's value (matches Redis SessionManager behavior).
    if (this.activeConnectionIds.get(keyId) !== connectionId) {
      console.log(
        `🔄 InMemorySessionManager: Aligning activeConnectionId[${keyId}] → ${connectionId}`,
      );
      this.activeConnectionIds.set(keyId, connectionId);
    }

    session.sseReply = reply;
    session.isActive = true;
    session.lastActivity = new Date();

    // Subscribe to in-memory events for this session and forward to SSE
    const publisher = InMemoryStreamPublisher.getInstance();
    session.unsubscribe = publisher.onSessionEvent(connectionId, (event: StreamEvent) => {
      this.routeEventToSSE(session!, event);
    });

    // Resolve the SSE connection promise (unblocks handshake tool if waiting)
    session.sseConnectionResolve();

    console.log(`📡 InMemorySessionManager: SSE connection registered for ${connectionId}`);
  }

  /**
   * Returns true when the given connection has a live, non-destroyed SSE reply.
   */
  hasActiveSSEConnection(connectionId: string): boolean {
    const session = this.sessions.get(connectionId);
    if (!session?.sseReply) return false;
    return !session.sseReply.raw.destroyed;
  }

  /**
   * Register a session by connectionId (backward-compat shim).
   */
  registerSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      const connectionId = sessionId;
      let resolveSSEConnection!: () => void;
      const sseConnectionPromise = new Promise<void>((resolve) => {
        resolveSSEConnection = resolve;
      });
      this.sessions.set(connectionId, {
        id: randomUUID(),
        connectionId,
        keyId: 0,
        createdAt: new Date(),
        lastActivity: new Date(),
        isActive: true,
        sseConnectionPromise,
        sseConnectionResolve: resolveSSEConnection,
      });
    }
    this.currentSessionId = sessionId;
  }

  /** Get a session by connectionId */
  getSession(connectionId: string): InMemorySession | undefined {
    return this.sessions.get(connectionId);
  }

  /** Get the most recently active sessionId */
  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  /** Wait until the SSE connection for connectionId is established */
  async waitForSSEConnection(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    await session.sseConnectionPromise;
  }

  /** Update the last-activity timestamp */
  async updateActivity(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (session) session.lastActivity = new Date();
  }

  /** Close a session and stop its event subscription */
  async closeSession(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    session.isActive = false;
    session.unsubscribe?.();
    session.unsubscribe = undefined;
    session.sseReply = undefined;

    console.log(`🔌 InMemorySessionManager: Session ${connectionId} closed`);

    // Keep for 1 hour for reconnect
    setTimeout(() => {
      this.sessions.delete(connectionId);
    }, 60 * 60 * 1000);
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    clearInterval(this.cleanupInterval);
    for (const [connectionId, session] of this.sessions) {
      session.unsubscribe?.();
      session.isActive = false;
      console.log(`🛑 InMemorySessionManager: Shutting down session ${connectionId}`);
    }
    this.sessions.clear();
    this.activeConnectionIds.clear();
  }

  // ------------------------------------------------------------------ //
  // Private helpers
  // ------------------------------------------------------------------ //

  private routeEventToSSE(session: InMemorySession, event: StreamEvent): void {
    if (!session.sseReply || !session.isActive || session.sseReply.raw.destroyed) {
      console.warn(
        `⚠️  InMemorySessionManager: No active SSE for ${session.connectionId}, dropping event ${event.toolName}`,
      );
      return;
    }
    session.sseReply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    session.lastActivity = new Date();
    console.log(
      `📤 InMemorySessionManager: Routed ${event.toolName} [${event.state}] → ${session.connectionId}`,
    );
  }

  private cleanupExpiredSessions(): void {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const [connectionId, session] of this.sessions) {
      if (!session.isActive && session.lastActivity < oneHourAgo) {
        session.unsubscribe?.();
        this.sessions.delete(connectionId);
        console.log(`🗑️  InMemorySessionManager: Cleaned up expired session ${connectionId}`);
      }
    }
  }
}
