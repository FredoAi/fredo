/**
 * DevMode Routes
 *
 * Exposes a single SSE endpoint:
 *   GET  /api/v1/dev-mode/stream?apiKey=...
 *
 * Every event published by any MCP tool across any session arrives here in
 * real-time via the global Redis PubSub channel `fredo:global:events`.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';
import type { StreamEvent } from '../../core/types/StreamEvent.js';

export class DevModeRoutes extends BaseRoutes {
  protected serviceName = 'dev-mode';
  protected serviceInstance: any;

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    this.serviceInstance = options['dev-modeService'];

    // ── OPTIONS /dev-mode/stream ─ CORS preflight ──────────────────────────
    const optionsRoute = this.createRoute({
      method: 'OPTIONS' as any,
      url: '/stream',
      schema: {
        description: 'CORS preflight for dev-mode SSE stream',
        tags: ['dev-mode'],
        response: { 200: { type: 'null', description: 'No content' }, 204: { type: 'null', description: 'No content' } }
      },
      handler: async (_request: FastifyRequest, reply: FastifyReply) => {
        reply
          .header('Access-Control-Allow-Origin', '*')
          .header('Access-Control-Allow-Methods', 'GET, OPTIONS')
          .header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control')
          .header('Access-Control-Max-Age', '86400')
          .code(204)
          .send();
      }
    });

    fastify.route(optionsRoute);

    // ── GET /dev-mode/stream ─ SSE global event stream ─────────────────────
    const streamRoute = this.createRoute({
      method: 'GET',
      url: '/stream',
      schema: {
        description:
          'SSE stream that broadcasts ALL tool events from ALL MCP sessions in real-time. ' +
          'Connect from the browser extension dev-mode page with ?apiKey=<key>.',
        tags: ['dev-mode'],
        querystring: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'API key (required — EventSource cannot set headers)' }
          }
        },
        response: {
          200: {
            type: 'object',
            description: 'Server-Sent Events stream',
            properties: {
              type: { type: 'string' },
              timestamp: { type: 'string' }
            }
          }
        }
      },
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        console.log('\n[DevMode] 🛠️  Dev-mode SSE client connected');
        console.log('   IP:', request.ip);

        // Force HTTP/1.1 for SSE compatibility (HTTP/2 can cause issues with long-lived streams)
        if (request.raw.httpVersion === '2.0') {
          reply.header('Connection', 'keep-alive');
        }
        
        // Set CORS headers BEFORE hijacking to ensure they're sent
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
        reply.header('Access-Control-Expose-Headers', 'Content-Type');
        
        // Hijack and set SSE headers
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        // ── Initial connected message ────────────────────────────────────────
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`
        );

        // ── Subscribe to all global events ──────────────────────────────────
        const unsubscribe = this.serviceInstance.onEvent((event: StreamEvent) => {
          if (!reply.raw.destroyed) {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        });

        // ── Heartbeat every 30 s ─────────────────────────────────────────────
        const heartbeatInterval = setInterval(() => {
          if (reply.raw.destroyed) {
            clearInterval(heartbeatInterval);
            return;
          }
          reply.raw.write(
            `data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`
          );
        }, 30_000);

        // ── Cleanup on disconnect ────────────────────────────────────────────
        request.raw.on('close', () => {
          console.log('[DevMode] 🛠️  Dev-mode SSE client disconnected');
          clearInterval(heartbeatInterval);
          unsubscribe();
        });
      }
    });

    fastify.route(streamRoute);

    console.log('[DevModeRoutes] ✅ Registered: GET /api/v1/dev-mode/stream');
  }
}

/**
 * Backwards-compatibility named export used by Router:
 *   service.routes.register === 'function'
 */
const devModeRoutesInstance = new DevModeRoutes();

export async function register(fastify: any, options: any): Promise<void> {
  await devModeRoutesInstance.register(fastify, options);
}

export default devModeRoutesInstance;

