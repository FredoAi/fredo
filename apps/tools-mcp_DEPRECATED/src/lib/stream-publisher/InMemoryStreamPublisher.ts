/**
 * InMemoryStreamPublisher — EventEmitter-backed stream publisher
 *
 * Replaces the Redis-based StreamPublisher when running embedded inside
 * the VS Code extension host.  Events are dispatched synchronously within
 * the same Node.js process — no Redis round-trip, no external dependency.
 */

import { EventEmitter } from 'node:events';
import { StreamEvent, PublishOptions } from '../../core/types/StreamEvent.js';
import type { IStreamPublisher } from './IStreamPublisher.js';

export class InMemoryStreamPublisher implements IStreamPublisher {
  private static _instance: InMemoryStreamPublisher | undefined;
  private readonly emitter = new EventEmitter();

  private constructor() {
    // Allow many per-session listeners without triggering Node's leak warning
    this.emitter.setMaxListeners(100);
  }

  /** Get or create the singleton */
  static getInstance(): InMemoryStreamPublisher {
    if (!InMemoryStreamPublisher._instance) {
      InMemoryStreamPublisher._instance = new InMemoryStreamPublisher();
    }
    return InMemoryStreamPublisher._instance;
  }

  /** Reset singleton (for testing or server restart) */
  static reset(): void {
    InMemoryStreamPublisher._instance = undefined;
  }

  // ------------------------------------------------------------------ //
  // IStreamPublisher interface
  // ------------------------------------------------------------------ //

  async connect(): Promise<void> {
    // No-op — in-memory needs no connection
  }

  async disconnect(): Promise<void> {
    this.emitter.removeAllListeners();
  }

  async publish(event: StreamEvent, options?: Partial<PublishOptions>): Promise<string> {
    const sessionId = options?.sessionId ?? event.sessionId;
    const eventId = `inmem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const enriched: StreamEvent = {
      ...event,
      sessionId,
      eventId,
      timestamp: event.timestamp || new Date().toISOString(),
      correlationId: options?.correlationId ?? event.correlationId,
    };

    // Route to the specific session listener (registered by InMemorySessionManager)
    this.emitter.emit(`session:${sessionId}`, enriched);

    // Global channel for dev-mode tooling
    this.emitter.emit('global', enriched);

    console.log(`📤 [InMemory] Published ${enriched.toolName} [${enriched.state}] → session:${sessionId}`);
    return eventId;
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('global');
  }

  // ------------------------------------------------------------------ //
  // Extra helpers used by InMemorySessionManager
  // ------------------------------------------------------------------ //

  /**
   * Subscribe to events routed to a specific sessionId.
   * Returns an unsubscribe function.
   */
  onSessionEvent(
    sessionId: string,
    handler: (event: StreamEvent) => void,
  ): () => void {
    const key = `session:${sessionId}`;
    this.emitter.on(key, handler);
    return () => this.emitter.off(key, handler);
  }

  /**
   * Subscribe to all events (the 'global' channel).
   * Used by DevModeService in embedded mode instead of Redis PubSub.
   * Returns an unsubscribe function.
   */
  onGlobalEvent(handler: (event: StreamEvent) => void): () => void {
    this.emitter.on('global', handler);
    return () => this.emitter.off('global', handler);
  }

  /**
   * Publish to the global dev-mode channel only (no session stream write).
   * Mirrors StreamPublisher.publishToDevMode() for embedded mode.
   */
  async publishToDevMode(
    event: Partial<StreamEvent> & { toolName: string; state: string; sessionId: string },
  ): Promise<void> {
    const enriched = {
      ...event,
      eventId: event.eventId || `inmem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: event.timestamp || new Date().toISOString(),
    };
    this.emitter.emit('global', enriched);
  }
}
