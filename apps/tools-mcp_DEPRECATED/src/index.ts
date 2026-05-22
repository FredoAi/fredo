import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import * as fs from 'fs';
import * as net from 'net';
import { ServiceLoader } from './core/loader.js';
import { Router } from './core/router.js';
import { StreamPublisher } from './lib/stream-publisher/StreamPublisher.js';
import { SessionManager } from './core/SessionManager.js';
import { RedisStreamConfig } from './core/types/StreamEvent.js';


const TOOL_BRIDGE_SOCKET = process.env.TOOL_BRIDGE_SOCKET ?? '/var/run/fredo/tools.sock';

// ---------------------------------------------------------------------------
// Unix Socket Tool Bridge
// Python/JS/Go code running inside the code_execute sandbox connects to this
// socket and sends { tool, input } JSON lines. We execute the tool directly
// and write the result back — no HTTP round-trip needed.
// ---------------------------------------------------------------------------
function startToolBridge(serviceLoader: ServiceLoader): void {
  const socketPath = TOOL_BRIDGE_SOCKET;
  const socketDir = socketPath.substring(0, socketPath.lastIndexOf('/'));

  try {
    fs.mkdirSync(socketDir, { recursive: true });
  } catch { /* already exists */ }

  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const socketServer = net.createServer((conn) => {
    let buffer = '';

    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        handleBridgeCall(serviceLoader, line.trim())
          .then((result) => conn.write(JSON.stringify(result) + '\n'))
          .catch((err) => conn.write(JSON.stringify({ error: String(err) }) + '\n'));
      }
    });

    conn.on('error', (err) => console.error('[ToolBridge] socket error:', err.message));
  });

  socketServer.listen(socketPath, () => {
    console.log(`[ToolBridge] Listening on ${socketPath}`);
  });

  socketServer.on('error', (err) => console.error('[ToolBridge] server error:', err));
}

async function handleBridgeCall(serviceLoader: ServiceLoader, raw: string): Promise<unknown> {
  let parsed: { tool: string; input: unknown; sessionId?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Invalid JSON' };
  }
  const { tool: toolName, input, sessionId } = parsed;
  if (!toolName || typeof toolName !== 'string') {
    return { error: 'tool field required' };
  }
  const toolInstance = serviceLoader.getTool(toolName);
  if (!toolInstance) {
    return { error: `Tool '${toolName}' not found` };
  }
  try {
    const context = { transport: 'api' as const, ...(sessionId ? { sseConnectionId: sessionId } : {}) };
    return await toolInstance.execute(input, context);
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

// Inline schemas for basic endpoints
const basicSchemas = {
  HealthResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'OK' },
      timestamp: { type: 'string', format: 'date-time' }
    }
  }
};

/**
 * Create and configure Fastify app.
 * Exported so embedded.ts can call it directly without the Redis / dotenv
 * bootstrap that start() performs.
 * @param preloadedServiceLoader Optional pre-created service loader (for embedded mode).
 *   When omitted, the standard dynamic ServiceLoader is used.
 */
export async function createApp(preloadedServiceLoader?: ServiceLoader): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info'
    },
    bodyLimit: 50 * 1024 * 1024 // 50MB limit for large log batches
  });

  // Initialize service loader first to get service information
  const serviceLoader = preloadedServiceLoader ?? new ServiceLoader();
  if (!preloadedServiceLoader) {
    await serviceLoader.loadServices();
  }
  const services = serviceLoader.getServices();

  // Generate Swagger tags dynamically from services with routes
  const serviceTags = services
    .filter(service => service.routes !== null)
    .map(service => ({
      name: service.name,
      description: `${service.name} service endpoints`
    }));

  // Register Swagger for API documentation with dynamic tags
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Fredo API',
        description: 'AI tooling framework API documentation',
        version: '1.0.0',
        contact: {
          name: 'Fredo Team',
          email: 'support@fredo.com'
        }
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Local development server'
        },
        {
          url: 'http://localhost:3000',
          description: 'Development server'
        }
      ],
      tags: [
        { name: 'Health', description: 'Health check endpoints' },
        ...serviceTags
      ]
    }
  });

  // Swagger UI serves static assets (logo.svg etc.) from its own package directory
  // using __dirname. When bundled by esbuild those paths break, so we skip it in
  // embedded mode — the /docs endpoint isn't needed inside the VS Code extension.
  if (process.env.FREDO_EMBEDDED !== 'true') {
    await fastify.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'full',
        deepLinking: false
      },
      staticCSP: true
    });
  }

  // Register plugins with comprehensive CORS support
  await fastify.register(cors, {
    origin: '*', // Allow all origins including chrome-extension:// and vscode-webview://
    credentials: false, // Must be false when origin is '*' — CORS spec forbids credentials+wildcard
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'Cache-Control', 'X-Requested-With', 'Mcp-Session-Id'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    preflightContinue: false,
    optionsSuccessStatus: 204
  });

  await fastify.register(helmet, {
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false, // Disable COEP to allow SSE streams from vscode-webview and chrome-extension origins
    crossOriginOpenerPolicy: false    // Disable COOP to allow cross-origin access
  });

  // Register service routes automatically
  const router = new Router(fastify, serviceLoader);
  await router.registerServiceRoutes(services);

  fastify.log.info(`🚀 Loaded ${services.length} services automatically`);
  console.log('🔥 Hot reload SUCCESS - http.ts removed!');

  // Tool bridge (Unix socket) — skip in embedded mode (no /var/run on Windows) and mcp-server
  if (process.env.FREDO_EMBEDDED !== 'true' && process.env.SERVER_TYPE !== 'mcp') {
    startToolBridge(serviceLoader);
  }

  // OAuth discovery — return 404 so VS Code skips OAuth and uses Bearer headers directly
  fastify.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    return reply.code(404).send({ error: 'Not found' });
  });
  fastify.get('/.well-known/oauth-protected-resource', async (_request, reply) => {
    return reply.code(404).send({ error: 'Not found' });
  });
  fastify.get('/.well-known/openid-configuration', async (_request, reply) => {
    return reply.code(404).send({ error: 'Not found' });
  });

  // Active session endpoint — returns the connectionId for the current connection.
  // Exposed here (Fastify/api-server at localhost:3000) so the webview can poll it
  // without CORS issues, since all webview API calls already go to this origin.
  fastify.get('/api/session/active', async (_request, reply) => {
    const sessionManager = SessionManager.getInstance();
    const connectionId = await sessionManager.getOrCreateActiveSession(0);
    return reply.send({ connectionId });
  });

  // Health check endpoint
  fastify.get('/health', {
    schema: {
      description: 'Health check endpoint to verify API status',
      tags: ['Health'],
      response: {
        200: basicSchemas.HealthResponse
      }
    }
  }, async () => {
    return { status: 'OK', timestamp: new Date().toISOString() };
  });

  return fastify;
}

/**
 * Application entry point
 */
async function start() {
  try {
    // Redis is optional — only connect when REDIS_HOST is explicitly set
    if (process.env.REDIS_HOST) {
      const redisConfig: RedisStreamConfig = {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        streamKeyPattern: 'fredo:sessions:{sessionId}:events',
        maxLength: 1000,
        ttl: 24 * 60 * 60 // 24 hours
      };

      console.log('🔴 Initializing Redis Stream Publisher...');
      const publisher = StreamPublisher.getInstance(redisConfig);
      await publisher.connect();
      console.log('✅ Redis Stream Publisher connected');

      console.log('🔴 Initializing Session Manager...');
      const sessionManager = SessionManager.getInstance();
      sessionManager.initializeRedis(redisConfig);
      console.log('✅ Session Manager initialized with Redis config');
    } else {
      console.log('ℹ️  No REDIS_HOST set — running without Redis (in-memory streams only)');
    }

    const app = await createApp();
    
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ port, host });
    
    // Show the correct external URL for Docker environment
    const displayHost = process.env.NODE_ENV === 'development' ? 'localhost' : host;
    console.log(`🚀 Fredo server running on http://${displayHost}:${port}`);
    console.log(`📖 API documentation available at http://${displayHost}:${port}/docs`);
    console.log(`❤️  Health check at http://${displayHost}:${port}/health`);

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down gracefully`);
  if (StreamPublisher.hasInstance()) {
    const publisher = StreamPublisher.getInstance();
    await publisher.disconnect();
  }
  const sessionManager = SessionManager.getInstance();
  await sessionManager.shutdown();
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Only auto-start when run directly; skip when embedded inside VS Code extension
if (process.env.FREDO_EMBEDDED !== 'true') {
  start();
}