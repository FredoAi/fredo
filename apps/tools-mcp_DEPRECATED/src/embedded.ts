/**
 * embedded.ts — Clean entry point for running tools-mcp embedded inside the VS Code extension host.
 *
 * The VS Code extension's ServerManager imports this module and calls
 * `startEmbeddedServers(config)`.  All tool business logic in `src/services/`
 * is unchanged — only the transport layer (Redis → in-memory) and startup
 * sequence differ from the standalone Docker deployment.
 */

import { EmbeddedServiceLoader } from './core/EmbeddedServiceLoader.js';
import { MCPServer } from './core/mcpServer.js';
import type { ServiceLoader } from './core/loader.js';
import { InMemoryStreamPublisher } from './lib/stream-publisher/InMemoryStreamPublisher.js';
import { InMemorySessionManager } from './core/InMemorySessionManager.js';
import { StreamPublisher, setEmbeddedPublisher } from './lib/stream-publisher/StreamPublisher.js';
import { SessionManager } from './core/SessionManager.js';
import { RedisStreamConfig } from './core/types/StreamEvent.js';
import { createApp } from './index.js';
import type { FastifyInstance } from 'fastify';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ------------------------------------------------------------------ //
// Public types
// ------------------------------------------------------------------ //

export interface EmbeddedConfig {
  apiPort: number;
  mcpPort: number;
  apiKey?: string;

  // Redis — omit / empty string for in-memory mode
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;

  // Postgres
  postgresConnectionString?: string;

  // Azure DevOps
  azdoPat?: string;
  azdoOrgUrl?: string;
  azdoProject?: string;

  // Jira
  jiraBaseUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  jiraUseMock?: boolean;

  // Optimizely
  optimizelySdkKey?: string;
  optimizelyProjectId?: string;
  optimizelyBaseUrl?: string;

  // Kubernetes
  kubeconfigPath?: string;

  // Code execution sandbox
  codeSandboxUrl?: string;

  logLevel?: string;
}

export interface EmbeddedServers {
  stop(): Promise<void>;
}

// ------------------------------------------------------------------ //
// Entry point
// ------------------------------------------------------------------ //

/**
 * Start both the Fastify REST API server and the MCP/SSE server in-process.
 * Returns a handle whose `stop()` method shuts both servers down cleanly.
 */
export async function startEmbeddedServers(config: EmbeddedConfig): Promise<EmbeddedServers> {
  // Signal to index.ts / mcp-server.ts that they should not auto-start
  process.env.FREDO_EMBEDDED = 'true';

  // Inject all configuration into process.env before any tool code runs
  applyEnvConfig(config);

  // ------------------------------------------------------------------ //
  // 0. Load all services once (shared between API server and MCP server)
  // ------------------------------------------------------------------ //
  const serviceLoader = new EmbeddedServiceLoader();
  await serviceLoader.loadServices();

  // ------------------------------------------------------------------ //
  // 1. Initialise stream transport
  // ------------------------------------------------------------------ //
  const redisConfig: RedisStreamConfig | undefined = config.redisHost
    ? {
        host: config.redisHost,
        port: config.redisPort ?? 6379,
        password: config.redisPassword,
        streamKeyPattern: 'fredo:sessions:{sessionId}:events',
        maxLength: 1000,
        ttl: 24 * 60 * 60,
      }
    : undefined;

  if (redisConfig) {
    console.log('[Embedded] 🔴 Connecting to Redis at', redisConfig.host);
    const publisher = StreamPublisher.getInstance(redisConfig);
    await publisher.connect();
    const sessionManager = SessionManager.getInstance();
    sessionManager.initializeRedis(redisConfig);
    console.log('[Embedded] ✅ Redis transport ready');
  } else {
    console.log('[Embedded] 💡 Using in-memory transport (no Redis configured)');
    // Create the in-memory publisher singleton and register it as the
    // StreamPublisher override so all StreamPublisher.getInstance() calls
    // (in tools, mcpServer, etc.) transparently use in-memory delivery.
    const inMemPub = InMemoryStreamPublisher.getInstance();
    setEmbeddedPublisher(inMemPub as unknown as StreamPublisher);
    InMemorySessionManager.getInstance();
  }

  // ------------------------------------------------------------------ //
  // 2. Start Fastify REST API server
  // ------------------------------------------------------------------ //
  const fastify: FastifyInstance = await createApp(serviceLoader as unknown as ServiceLoader);
  await fastify.listen({ port: config.apiPort, host: '127.0.0.1' });
  console.log(`[Embedded] 🚀 Fastify API ready on http://127.0.0.1:${config.apiPort}`);

  // ------------------------------------------------------------------ //
  // 3. Start MCP/SSE HTTP server
  // ------------------------------------------------------------------ //
  const mcpHttpServer = await startEmbeddedMCPServer(config.mcpPort, serviceLoader);
  console.log(`[Embedded] 🚀 MCP server ready on http://127.0.0.1:${config.mcpPort}`);

  // ------------------------------------------------------------------ //
  // 4. Return stop handle
  // ------------------------------------------------------------------ //
  return {
    async stop(): Promise<void> {
      console.log('[Embedded] Shutting down embedded servers...');

      await fastify.close();
      await new Promise<void>((resolve, reject) =>
        mcpHttpServer.close((err) => (err ? reject(err) : resolve())),
      );

      if (redisConfig) {
        await StreamPublisher.getInstance().disconnect();
        await SessionManager.getInstance().shutdown();
      } else {
        await InMemoryStreamPublisher.getInstance().disconnect();
        await InMemorySessionManager.getInstance().shutdown();
      }

      console.log('[Embedded] ✅ All servers stopped');
    },
  };
}

// ------------------------------------------------------------------ //
// Internal helpers
// ------------------------------------------------------------------ //

/**
 * Start the MCP HTTP server (replicates mcp-server.ts startMCPServer() logic
 * but accepts config from the caller instead of process.argv / process.env).
 */
async function startEmbeddedMCPServer(port: number, serviceLoader: EmbeddedServiceLoader): Promise<http.Server> {
  const mcpServer = new MCPServer(serviceLoader as any);

  // Inline the HTTP server setup that MCPServer.start('sse') would do so we can
  // bind to 127.0.0.1 only (not 0.0.0.0) for security in the embedded case.
  const httpServer = http.createServer();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionManager = process.env.FREDO_REDIS_HOST
    ? SessionManager.getInstance()
    : InMemorySessionManager.getInstance() as any; // compatible public API

  httpServer.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Health check (no auth)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', timestamp: new Date().toISOString() }));
      return;
    }

    // OAuth discovery stubs — tell VS Code to use Bearer headers directly
    if (url.pathname.startsWith('/.well-known/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/sse') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (req.method === 'POST') {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessionManager.registerSession(sid);
            transports.set(sid, transport);
          },
          onsessionclosed: (sid) => {
            sessionManager.unregisterSession?.(sid);
            transports.delete(sid);
            mcpServer.unlockTool(sid, '*'); // internal cleanup signal (noop for unlockTool)
          },
        });
        await (mcpServer as any).server.connect(transport);
      } else {
        res.writeHead(404); res.end(); return;
      }

      await transport.handleRequest(req, res, await streamBody(req));
      return;
    }

    res.writeHead(404); res.end();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => resolve());
    httpServer.once('error', reject);
  });

  return httpServer;
}

/** Read the full request body as a Buffer */
function streamBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Map EmbeddedConfig fields → process.env so all tools-mcp service code can
 * read configuration the same way it does in the Docker deployment.
 */
function applyEnvConfig(cfg: EmbeddedConfig): void {
  process.env.PORT          = String(cfg.apiPort);
  process.env.MCP_PORT      = String(cfg.mcpPort);

  if (cfg.apiKey)                    { process.env.API_KEY               = cfg.apiKey; }
if (cfg.redisHost)                 { process.env.REDIS_HOST             = cfg.redisHost;
                                        process.env.FREDO_REDIS_HOST       = cfg.redisHost; }
  if (cfg.redisPort)                 { process.env.REDIS_PORT             = String(cfg.redisPort); }
  if (cfg.redisPassword)             { process.env.REDIS_PASSWORD         = cfg.redisPassword; }
  if (cfg.postgresConnectionString)  { process.env.DATABASE_URL           = cfg.postgresConnectionString; }
  if (cfg.azdoPat)                   { process.env.AZDO_PAT               = cfg.azdoPat; }
  if (cfg.azdoOrgUrl)                { process.env.AZDO_ORG_URL           = cfg.azdoOrgUrl; }
  if (cfg.azdoProject)               { process.env.AZDO_PROJECT           = cfg.azdoProject; }
  if (cfg.jiraBaseUrl)               { process.env.JIRA_BASE_URL          = cfg.jiraBaseUrl; }
  if (cfg.jiraEmail)                 { process.env.JIRA_EMAIL             = cfg.jiraEmail; }
  if (cfg.jiraApiToken)              { process.env.JIRA_API_TOKEN         = cfg.jiraApiToken; }
  if (cfg.jiraUseMock)               { process.env.JIRA_USE_MOCK          = 'true'; }
  if (cfg.optimizelySdkKey)          { process.env.OPTIMIZELY_SDK_KEY     = cfg.optimizelySdkKey; }
  if (cfg.optimizelyProjectId)       { process.env.OPTIMIZELY_PROJECT_ID  = cfg.optimizelyProjectId; }
  if (cfg.optimizelyBaseUrl)         { process.env.OPTIMIZELY_BASE_URL    = cfg.optimizelyBaseUrl; }
  if (cfg.kubeconfigPath)            { process.env.KUBECONFIG             = cfg.kubeconfigPath; }
  if (cfg.codeSandboxUrl)            { process.env.SANDBOX_URL            = cfg.codeSandboxUrl; }
  process.env.LOG_LEVEL              = cfg.logLevel ?? 'warn';
  process.env.NODE_ENV               = process.env.NODE_ENV ?? 'production';
}
