/**
 * DevMode Service
 *
 * Subscribes to the global Redis PubSub channel `fredo:global:events` and fans
 * out every event to all connected dev-mode SSE clients via a local EventEmitter.
 *
 * Requires a separate Redis client because SUBSCRIBE blocks the connection — it
 * cannot share the same client used by StreamPublisher for XADD.
 */

import { BaseService } from '../../core/BaseService.js';
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import * as devModeRoutes from './routes.js';
import type { StreamEvent } from '../../core/types/StreamEvent.js';

export const GLOBAL_EVENTS_CHANNEL = 'fredo:global:events';

export class DevModeService extends BaseService {
  readonly name = 'dev-mode';
  readonly description = 'Dev-mode global event stream — broadcasts all tool events from all sessions';
  readonly routes = devModeRoutes;
  readonly model = null;
  readonly repository = null;
  readonly controller = null;

  private static instance: DevModeService;

  /** EventEmitter that fans out to all connected SSE clients */
  private eventEmitter: EventEmitter;
  /** Dedicated Redis subscriber client */
  private subscriber: Redis | null = null;

  constructor() {
    super();
    this.eventEmitter = new EventEmitter();
    this.eventEmitter.setMaxListeners(500); // support many concurrent dev-mode connections
  }

  static getInstance(): DevModeService {
    if (!DevModeService.instance) {
      DevModeService.instance = new DevModeService();
    }
    return DevModeService.instance;
  }

  registerRoutes(): void {
    console.log(`[DevModeService] Registering routes for ${this.name} service`);
  }

  async init(): Promise<void> {
    // ── No Redis configured — skip subscriber ────────────────────────────── //
    if (!process.env.REDIS_HOST) {
      if (process.env.FREDO_EMBEDDED === 'true') {
        console.log('[DevModeService] 💡 Embedded mode — wiring to InMemoryStreamPublisher instead of Redis');
        const { InMemoryStreamPublisher } = await import('../../lib/stream-publisher/InMemoryStreamPublisher.js');
        InMemoryStreamPublisher.getInstance().onGlobalEvent((event) => {
          this.eventEmitter.emit('event', event);
        });
      } else {
        console.log('[DevModeService] ℹ️  No REDIS_HOST set — dev-mode stream disabled (events will not be broadcast)');
      }
      return;
    }

    // ── Normal Redis mode ─────────────────────────────────────────────────── //
    try {
      this.subscriber = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 50, 2000),
      });

      this.subscriber.on('connect', () => {
        console.log('[DevModeService] ✅ Redis subscriber connected');
      });

      this.subscriber.on('error', (err) => {
        console.error('[DevModeService] ❌ Redis subscriber error:', err);
      });

      await this.subscriber.connect();
      await this.subscriber.subscribe(GLOBAL_EVENTS_CHANNEL);

      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel !== GLOBAL_EVENTS_CHANNEL) return;
        try {
          const event: StreamEvent = JSON.parse(message);
          this.eventEmitter.emit('event', event);
        } catch (err) {
          console.error('[DevModeService] Failed to parse PubSub message:', err);
        }
      });

      console.log(`[DevModeService] 📡 Subscribed to ${GLOBAL_EVENTS_CHANNEL}`);
    } catch (error) {
      console.error('[DevModeService] Failed to initialize Redis subscriber:', error);
      // Non-fatal — dev-mode stream simply won't receive events
    }
  }

  /**
   * Register a listener for all incoming global events.
   * Returns an unsubscribe function for cleanup on SSE close.
   */
  onEvent(handler: (event: StreamEvent) => void): () => void {
    this.eventEmitter.on('event', handler);
    return () => this.eventEmitter.off('event', handler);
  }

  /**
   * Number of currently connected dev-mode SSE clients (for debugging).
   */
  get listenerCount(): number {
    return this.eventEmitter.listenerCount('event');
  }

  async shutdown(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
  }
}
