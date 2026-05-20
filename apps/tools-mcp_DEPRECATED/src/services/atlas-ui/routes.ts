import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

export class AtlasUiRoutes extends BaseRoutes {
  protected serviceName = 'atlas-ui';
  protected serviceInstance: any;

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    this.serviceInstance = options['atlas-uiService'];

    // Sessions are auto-created on first MCP tool call via SessionManager.getOrCreateActiveSession().
    // The webview connects directly with just the API key — no polling for connectionId needed.

    // GET /atlas-ui/stream — API-key-only SSE endpoint (no connectionId in path).
    // Resolves the active session connectionId from the API key and streams events.
    const streamByKeyRoute = this.createRoute({
      method: 'GET',
      url: '/stream',
      schema: {
        description: 'SSE stream resolved from API key. Client receives connectionId in the initial connected event.',
        tags: ['atlas-ui'],
        response: {
          200: {
            type: 'object',
            description: 'Server-Sent Events stream',
            properties: {
              type: { type: 'string' },
              connectionId: { type: 'string' },
              timestamp: { type: 'string' }
            }
          }
        }
      },
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const keyId: number = (request as any).keyId ?? 0;
        const { SessionManager } = await import('../../core/SessionManager.js');
        const sessionManager = SessionManager.getInstance();
        const connectionId = await sessionManager.getOrCreateActiveSession(keyId);

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('🌊 [SSE ROUTE] Webview connecting (apiKey-based)');
        console.log('   Resolved connectionId:', connectionId);
        console.log('   Client IP:', request.ip);
        console.log('═══════════════════════════════════════════════════════════\n');

        // Force HTTP/1.1 for SSE compatibility (HTTP/2 can cause issues with long-lived streams)
        if (request.raw.httpVersion === '2.0') {
          reply.header('Connection', 'keep-alive');
        }
        
        reply.hijack();

        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Cache-Control',
        });

        // Send connected event — client reads connectionId from here
        reply.raw.write(`data: ${JSON.stringify({
          type: 'connected',
          connectionId,
          timestamp: new Date().toISOString()
        })}\n\n`);

        try {
          let session = await sessionManager.getSession(connectionId);
          if (!session) {
            session = await sessionManager.createSession({
              connectionId,
              keyId,
              extensionVersion: 'unknown',
              capabilities: [],
              metadata: { source: 'sse-connect-apikey', timestamp: new Date().toISOString() }
            });
          }
          await sessionManager.registerSSEConnection(connectionId, reply, keyId);
        } catch (error) {
          reply.raw.write(`data: ${JSON.stringify({
            type: 'error',
            message: 'Failed to register connection',
            error: error instanceof Error ? error.message : 'Unknown error'
          })}\n\n`);
        }

        const unsubscribe = this.serviceInstance.subscribe(connectionId, (event: any) => {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          sessionManager.updateActivity(connectionId).catch(() => {});
        });

        const inactivityTimeout = 30 * 60 * 1000;
        let lastActivityTime = Date.now();
        const inactivityCheckInterval = setInterval(() => {
          if (Date.now() - lastActivityTime >= inactivityTimeout) {
            clearInterval(inactivityCheckInterval);
            clearInterval(heartbeatInterval);
            unsubscribe();
            sessionManager.closeSession(connectionId).catch(() => {});
            reply.raw.end();
          }
        }, 60000);

        request.raw.on('close', () => {
          clearInterval(inactivityCheckInterval);
          clearInterval(heartbeatInterval);
          unsubscribe();
          sessionManager.closeSession(connectionId).catch(() => {});
        });

        reply.raw.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);

        const heartbeatInterval = setInterval(() => {
          if (reply.raw.destroyed) {
            clearInterval(heartbeatInterval);
            clearInterval(inactivityCheckInterval);
            return;
          }
          lastActivityTime = Date.now();
          reply.raw.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);
        }, 15_000);
      }
    });

    fastify.route(streamByKeyRoute);

    // OPTIONS /atlas-ui/stream/:connectionId - CORS preflight for SSE
    const streamOptionsRoute = this.createRoute({
      method: 'OPTIONS' as any,
      url: '/stream/:connectionId',
      schema: {
        description: 'CORS preflight for SSE stream endpoint',
        tags: ['atlas-ui'],
        params: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' }
          }
        },
        response: {
          200: {
            type: 'null',
            description: 'CORS preflight successful'
          },
          204: {
            type: 'null',
            description: 'No content'
          }
        }
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

    fastify.route(streamOptionsRoute);

    // GET /atlas-ui/stream/:connectionId - SSE stream for browser extension
    const streamRoute = this.createRoute({
      method: 'GET',
      url: '/stream/:connectionId',
      schema: {
        description: 'SSE stream for receiving step updates. Browser extension subscribes to this with the MCP connection ID.',
        tags: ['atlas-ui'],
        params: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'MCP SSE connection ID to subscribe to'
            }
          },
          required: ['connectionId']
        },
        response: {
          200: {
            type: 'object',
            description: 'Server-Sent Events stream',
            properties: {
              type: { type: 'string' },
              data: { type: 'array' },
              connectionId: { type: 'string' },
              timestamp: { type: 'string' }
            }
          }
        }
      },
      handler: async (request: FastifyRequest<{ Params: { connectionId: string } }>, reply: FastifyReply) => {
        const { connectionId } = request.params;
        const keyId: number = (request as any).keyId ?? 0;

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('🌊 [SSE ROUTE] Browser extension connecting to stream');
        console.log('   Connection ID:', connectionId);
        console.log('   Client IP:', request.ip);
        console.log('   User-Agent:', request.headers['user-agent']);
        console.log('═══════════════════════════════════════════════════════════\n');

        // Force HTTP/1.1 for SSE compatibility (HTTP/2 can cause issues with long-lived streams)
        if (request.raw.httpVersion === '2.0') {
          reply.header('Connection', 'keep-alive');
        }
        
        // Set CORS headers BEFORE hijacking to ensure they're sent
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
        reply.header('Access-Control-Expose-Headers', 'Content-Type');

        // Prevent Fastify from finalising the response when the handler returns —
        // without this, Fastify calls reply.raw.end() which destroys the SSE stream.
        reply.hijack();

        // Set SSE headers
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no' // Disable nginx buffering
        });

        // Send initial connection message
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'connected', 
          connectionId,
          timestamp: new Date().toISOString()
        })}\n\n`);

        // Register SSE connection with SessionManager to start Redis stream consumer
        console.log('   🔌 Registering SSE connection with SessionManager...');
        const { SessionManager } = await import('../../core/SessionManager.js');
        const sessionManager = SessionManager.getInstance();
        
        try {
          // Check if session exists, create it if it doesn't (for cross-process MCP handshakes)
          let session = await sessionManager.getSession(connectionId);
          if (!session) {
            console.log('   ℹ️  Session not found in API server, creating it (cross-process MCP handshake)...');
            console.log('   📝 Creating session with connectionId:', connectionId);
            session = await sessionManager.createSession({
              connectionId,
              keyId,
              extensionVersion: 'unknown',
              capabilities: [],
              metadata: { source: 'sse-connect', timestamp: new Date().toISOString() }
            });
            console.log('   ✅ Session created:', session.id, '→ connectionId:', session.connectionId);
          } else {
            console.log('   ✅ Session found:', session.id);
          }
          
          await sessionManager.registerSSEConnection(connectionId, reply, keyId);
          console.log('   ✅ SessionManager registered, Redis consumer started for:', connectionId);
        } catch (error) {
          console.error('   ❌ Failed to register SSE connection:', error);
          console.error('   📋 Error details:', {
            connectionId,
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined
          });
          reply.raw.write(`data: ${JSON.stringify({ 
            type: 'error', 
            message: 'Failed to register connection',
            error: error instanceof Error ? error.message : 'Unknown error'
          })}\n\n`);
        }

        // Subscribe to step updates for this connection (fallback for local events)
        console.log('   📡 Subscribing to service events for connection:', connectionId);
        const unsubscribe = this.serviceInstance.subscribe(connectionId, (event: any) => {
          console.log('   📨 Received event from service, writing to SSE stream');
          const sseData = JSON.stringify(event);
          reply.raw.write(`data: ${sseData}\n\n`);
          
          // Update activity timestamp on any event
          sessionManager.updateActivity(connectionId).catch(err => 
            console.error('Failed to update activity:', err)
          );
        });
        console.log('   ✅ Subscription registered successfully');

        // Inactivity timeout - close connection after 30 minutes of no events
        const inactivityTimeout = 30 * 60 * 1000; // 30 minutes
        let lastActivityTime = Date.now();
        let inactivityCheckInterval: NodeJS.Timeout;
        
        // Update last activity on heartbeat
        const updateActivity = () => {
          lastActivityTime = Date.now();
        };
        
        // Check for inactivity every minute
        inactivityCheckInterval = setInterval(() => {
          const timeSinceLastActivity = Date.now() - lastActivityTime;
          
          if (timeSinceLastActivity >= inactivityTimeout) {
            console.log(`⏱️  [SSE ROUTE] Connection ${connectionId} inactive for ${Math.floor(timeSinceLastActivity / 60000)} minutes - closing`);
            clearInterval(inactivityCheckInterval);
            clearInterval(heartbeatInterval);
            unsubscribe();
            sessionManager.closeSession(connectionId).catch(err => 
              console.error('Failed to close session:', err)
            );
            reply.raw.end();
          }
        }, 60000); // Check every minute

        // Handle client disconnect — stop the stream consumer so unACKed messages
        // stay in the Redis PEL for re-delivery when the browser reconnects.
        request.raw.on('close', () => {
          console.log(`[AtlasUiRoutes] Browser extension disconnected from stream: ${connectionId}`);
          clearInterval(inactivityCheckInterval);
          unsubscribe();
          sessionManager.closeSession(connectionId).catch(err =>
            console.error('Failed to close session on disconnect:', err)
          );
        });

        // Keep connection alive with heartbeat
        // Send immediate heartbeat so proxies (nginx) don't cut the
        // idle connection before the 60s timeout fires.
        reply.raw.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);

        const heartbeatInterval = setInterval(() => {
          if (reply.raw.destroyed) {
            clearInterval(heartbeatInterval);
            clearInterval(inactivityCheckInterval);
            return;
          }
          updateActivity(); // Update activity on heartbeat
          reply.raw.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);
        }, 15_000); // Every 15 seconds — well under proxy idle timeouts

        request.raw.on('close', () => {
          clearInterval(heartbeatInterval);
          clearInterval(inactivityCheckInterval);
        });
      }
    });

    fastify.route(streamRoute);

    // POST /internal/broadcast - Internal endpoint for MCP server to broadcast events
    const broadcastRoute = this.createRoute({
      method: 'POST',
      url: '/internal/broadcast',
      schema: {
        description: 'Internal endpoint for MCP server to broadcast events to API server subscribers',
        tags: ['atlas-ui'],
        body: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            event: { type: 'object' }
          },
          required: ['connectionId', 'event']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' }
            }
          }
        }
      },
      handler: async (request: FastifyRequest<{ Body: { connectionId: string; event: any } }>, reply: FastifyReply) => {
        const { connectionId, event } = request.body;
        
        // Broadcast to local subscribers
        const eventName = `stepper:${connectionId}`;
        const listenerCount = (this.serviceInstance as any).eventEmitter.listenerCount(eventName);
        
        if (listenerCount > 0) {
          console.log(`[AtlasUiRoutes] Broadcasting MCP event to ${listenerCount} subscriber(s)`);
          (this.serviceInstance as any).eventEmitter.emit(eventName, event);
        }
        
        return reply.send({ success: true });
      }
    });

    fastify.route(broadcastRoute);

    // POST /response - Generic feature response endpoint
    const responseRoute = this.createRoute({
      method: 'POST',
      url: '/response',
      schema: {
        description: 'Receive generic responses from browser extension features',
        tags: ['atlas-ui'],
        body: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            featureId: { type: 'string' },
            payload: { type: 'object' },
            metadata: { type: 'object' }
          },
          required: ['connectionId', 'featureId', 'payload']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' }
            }
          }
        }
      },
      handler: async (request: FastifyRequest<{ Body: { connectionId: string; featureId: string; payload: Record<string, any>; metadata?: Record<string, any> } }>, reply: FastifyReply) => {
        const { connectionId, featureId, payload, metadata } = request.body;

        console.log(`\n📬 [GENERIC RESPONSE] ${featureId} from ${connectionId}`);

        try {
          // 1. Publish to Redis Stream for event-driven consumers
          const { StreamPublisher } = await import('../../lib/stream-publisher/StreamPublisher.js');
          const publisher = StreamPublisher.getInstance();
          await publisher.publishResponse('atlas_ui_response', connectionId, {
            featureId,
            payload,
            metadata: {
              timestamp: new Date().toISOString(),
              ...metadata
            }
          });

          // 2. Store in Redis for MCP retrieval
          const responseKey = `ui:response:${connectionId}:${featureId}:${Date.now()}`;
          const responseData = JSON.stringify({
            featureId,
            payload,
            metadata: {
              timestamp: new Date().toISOString(),
              ...metadata
            }
          });

          const Redis = (await import('ioredis')).default;
          const redis = new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
            db: parseInt(process.env.REDIS_DB || '0'),
          });

          await redis.setex(responseKey, 300, responseData); // 5 min TTL
          await redis.quit();
          
          console.log(`   💾 Stored response in Redis: ${responseKey}`);

          reply.send({
            success: true,
            message: 'Response received and stored'
          });
        } catch (error) {
          console.error('❌ Error processing response:', error);
          reply.code(500).send({
            success: false,
            message: 'Failed to process response'
          });
        }
      }
    });

    fastify.route(responseRoute);
  }
}

/**
 * Backwards compatibility export
 */
const AtlasUiRoutesInstance = new AtlasUiRoutes();

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  await AtlasUiRoutesInstance.register(fastify, options);
}

export default AtlasUiRoutesInstance;
