import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ServiceLoader } from './loader.js';
import { SessionManager } from './SessionManager.js';
import * as http from 'http';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

/**
 * MCP Server implementation for Fredo
 * Exposes service tools via the Model Context Protocol
 */
export class MCPServer {
  private server: Server;
  private serviceLoader: ServiceLoader;
  private redis: Redis;


  /**
   * Per-session set of tool names that have been unlocked via tool_search.
   * Tools with deferLoading=true are hidden from ListTools until present here.
   */
  private unlockedTools = new Map<string, Set<string>>();

  constructor(serviceLoader: ServiceLoader) {
    this.serviceLoader = serviceLoader;
    
    // Initialize Redis client for checking UI responses.
    // In embedded mode without Redis configured, skip creating the client —
    // checkUIResponses() returns [] when this.redis is null.
    const redisHost = process.env.REDIS_HOST || process.env.FREDO_REDIS_HOST;
    if (redisHost) {
      this.redis = new Redis({
        host: redisHost,
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      this.redis.on('error', (err) => {
        // Suppress connection errors — UI-response polling is best-effort
        console.warn('[MCPServer] Redis UI-response client error (non-fatal):', err.message);
      });
    } else {
      this.redis = null as any;
    }
    
    this.server = new Server(
      {
        name: 'Fredo-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.logToolStats();
  }

  /**
   * Unlock a tool for the given session, making it visible in subsequent ListTools calls.
   * Called by ToolSearchTool when results are returned to the client.
   * @param sessionId - MCP session ID or connectionId
   * @param toolName  - tool.name to unlock
   */
  unlockTool(sessionId: string, toolName: string): void {
    let sessionSet = this.unlockedTools.get(sessionId);
    if (!sessionSet) {
      sessionSet = new Set<string>();
      this.unlockedTools.set(sessionId, sessionSet);
    }
    sessionSet.add(toolName);
    console.log(`[MCPServer] Unlocked tool '${toolName}' for session '${sessionId}'`);
  }

  /**
   * Log tool statistics on startup
   */
  private logToolStats(): void {
    const allTools = this.serviceLoader.getTools();
    const mcpTools = allTools.filter(tool => {
      const exposedAs = tool.exposedAs || 'both';
      return exposedAs === 'mcp' || exposedAs === 'both';
    });
    const apiOnlyTools = allTools.filter(tool => tool.exposedAs === 'api');
    
    console.log(`\n[MCPServer] Tool Exposure Summary:`);
    console.log(`  Total tools: ${allTools.length}`);
    console.log(`  MCP-exposed tools: ${mcpTools.length} (${mcpTools.map(t => t.name).join(', ')})`);
    console.log(`  API-only tools: ${apiOnlyTools.length} (${apiOnlyTools.map(t => t.name).join(', ')})\n`);
  }

  /**
   * Set up MCP protocol handlers
   */
  private setupHandlers(): void {
    // Handle tool listing - filter by exposedAs and deferLoading properties
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = this.serviceLoader.getTools();
      
      // For stdio transport there is no per-session unlock state; use empty set.
      const unlocked = new Set<string>();

      // Filter tools: only expose those with exposedAs === 'mcp' or 'both'
      // AND that are not deferred (or have already been unlocked)
      const mcpTools = allTools.filter(tool => {
        const exposedAs = tool.exposedAs || 'both';
        if (exposedAs !== 'mcp' && exposedAs !== 'both') return false;
        if ((tool.deferLoading ?? false) && !unlocked.has(tool.name)) return false;
        return true;
      });

      const tools = mcpTools.map(tool => {
        // Use tool's own schema if provided, otherwise use generic schema
        const inputSchema = tool.inputSchema || {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Query parameters for the tool'
            }
          },
          required: []
        };

        return {
          name: tool.name,
          description: tool.description || `${tool.name} tool`,
          inputSchema
        };
      });

      console.log(`[MCPServer] Exposing ${tools.length} tools via MCP (filtered from ${allTools.length} total)`);
      return { tools };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      const tool = this.serviceLoader.getTool(name);
      if (!tool) {
        throw new Error(`Tool ${name} not found`);
      }

      // Check if tool is exposed via MCP
      const exposedAs = tool.exposedAs || 'both';
      console.log(`[MCPServer] Tool ${name} execution check: exposedAs=${exposedAs}, type=${typeof tool.exposedAs}, value=${tool.exposedAs}`);
      
      if (exposedAs === 'api') {
        throw new Error(`Tool ${name} is only available via API, not MCP`);
      }

      try {
        // Auto-create or get the active session — no handshake call required
        // stdio transport has no auth context; use keyId=0 as sentinel
        const sessionManager = SessionManager.getInstance();
        const connectionIdForTool = await sessionManager.getOrCreateActiveSession(0);

        console.error(`[MCPServer] Tool ${name} executing with connectionId: ${connectionIdForTool}`);
        
        // Pass MCP transport context to tool (includes unlock callback for tool_search)
        const context = { 
          sseConnectionId: connectionIdForTool,
          transport: 'mcp',
          unlockTool: (toolName: string) => this.unlockTool(connectionIdForTool, toolName)
        };

        // Publish Init/Response to dev-mode PubSub for tools that don't self-publish.
        // (kubectl_*, k8s_diagram, fredo_ui_alert, fredo_ui_stepper call StreamPublisher.publish()
        //  themselves, which already includes the fredo:global:events PubSub publish.)
        const shouldPublishDevMode = name !== 'tools_documentation'
          && name !== 'k8s_diagram'
          && !name.startsWith('kubectl_')
          && name !== 'fredo_ui_alert'
          && name !== 'fredo_ui_stepper';

        const { StreamPublisher } = await import('../lib/stream-publisher/StreamPublisher.js');
        const publisher = StreamPublisher.getInstance();

        if (shouldPublishDevMode) {
          await publisher.publishToDevMode({ toolName: name, sessionId: connectionIdForTool, state: 'Init', input: args });
        }

        const result = await tool.execute(args || {}, context);

        if (shouldPublishDevMode) {
          await publisher.publishToDevMode({ toolName: name, sessionId: connectionIdForTool, state: 'Response', response: result });
        }
        
        // Check for UI responses from browser extension
        const uiResponses = await this.checkUIResponses(connectionIdForTool);
        
        // Compact JSON to LLM; short-circuit empty results to avoid raw [] in context
        let responseText: string;
        if (typeof result === 'string') {
          responseText = result;
        } else if (Array.isArray(result) && result.length === 0) {
          responseText = 'No results found for the given query.';
        } else if (result !== null && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0) {
          responseText = 'No results found.';
        } else {
          responseText = JSON.stringify(result);
        }

        // Append UI responses if any exist
        if (uiResponses.length > 0) {
          responseText = `${responseText}\n\n📬 UI Responses:\n${JSON.stringify({ uiResponses: uiResponses })}`;
        }

        // Hard cap: prevent any single tool response from exceeding ~4K tokens.
        // Protects against tools that return unexpectedly large payloads.
        const MAX_RESPONSE_CHARS = 15_000;
        if (responseText.length > MAX_RESPONSE_CHARS) {
          const originalLength = responseText.length;
          responseText = responseText.slice(0, MAX_RESPONSE_CHARS) + `…[truncated: ${originalLength} chars total]`;
          console.error(`[MCPServer] Response for ${name} truncated: ${originalLength} → ${MAX_RESPONSE_CHARS} chars`);
        }

        return {
          content: [
            {
              type: 'text',
              text: responseText
            }
          ]
        };
      } catch (error) {
        const { StreamPublisher } = await import('../lib/stream-publisher/StreamPublisher.js');
        const publisher = StreamPublisher.getInstance();
        const sessionManager = SessionManager.getInstance();
        const connectionId = sessionManager.getActiveConnectionId(0) || sessionManager.getCurrentSessionId();
        const shouldPublishDevMode = name !== 'tools_documentation'
          && name !== 'k8s_diagram'
          && !name.startsWith('kubectl_')
          && name !== 'fredo_ui_alert'
          && name !== 'fredo_ui_stepper';
        if (shouldPublishDevMode && connectionId) {
          await publisher.publishToDevMode({ toolName: name, sessionId: connectionId, state: 'Error', error: { message: error instanceof Error ? error.message : 'Unknown error' } });
        }
        throw new Error(`Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });
  }

  /**
   * Check Redis for UI responses from browser extension
   * Returns array of responses and deletes them from Redis
   */
  private async checkUIResponses(connectionId: string): Promise<any[]> {
    if (!this.redis) return []; // no Redis in embedded/in-memory mode
    try {
      const pattern = `ui:response:${connectionId}:*`;
      const keys = await this.redis.keys(pattern);
      
      if (keys.length === 0) {
        return [];
      }

      console.log(`\n📬 [MCP] Found ${keys.length} UI responses for ${connectionId}`);
      
      const responses = [];
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          const response = JSON.parse(data);
          responses.push(response);
          console.log(`   ✅ Retrieved response from feature: ${response.featureId}`);
          
          // Delete the response key after retrieval to prevent duplicates
          await this.redis.del(key);
        }
      }
      
      console.log(`   🗑️  Deleted ${keys.length} response keys from Redis\n`);
      return responses;
    } catch (error) {
      console.error('❌ Error checking UI responses:', error);
      return [];
    }
  }

  /**
   * Start the MCP server with specified transport
   */
  async start(transport: 'stdio' | 'sse' = 'stdio', port?: number): Promise<void> {
    if (transport === 'sse') {
      await this.startHTTPServer(port || 3001);
    } else {
      const stdioTransport = new StdioServerTransport();
      await this.server.connect(stdioTransport);
      console.error('Fredo MCP Server started (stdio)'); // Use stderr for logging in MCP
    }
  }

  /**
   * Start HTTP server with Streamable HTTP transport for MCP protocol
   */
  private async startHTTPServer(port: number): Promise<void> {
    const httpServer = http.createServer();
    const transports = new Map<string, StreamableHTTPServerTransport>();
    
    httpServer.on('request', async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      
      // CORS headers for web access
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // OAuth discovery probes — return 404 so VS Code skips OAuth and uses Bearer headers
      if (url.pathname.startsWith('/.well-known/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // MCP endpoint - handles GET, POST, DELETE per Streamable HTTP spec
      if (url.pathname === '/sse') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;
        
        if (sessionId && transports.has(sessionId)) {
          // Reuse existing transport
          transport = transports.get(sessionId)!;
        } else if (req.method === 'POST') {
          // New session - create transport with session management
          const sessionManager = SessionManager.getInstance();
          // sessionId is assigned inside onsessioninitialized; pass a lazy getter
          // so the ListTools handler can look up the unlock set after init.
          let assignedSessionId: string | undefined;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              console.error(`Session initialized: ${sid}`);
              assignedSessionId = sid; // capture for the lazy getter
              sessionManager.registerSession(sid);
              transports.set(sid, transport);
            },
            onsessionclosed: (sid) => {
              console.error(`Session closed: ${sid}`);
              sessionManager.unregisterSession(sid);
              transports.delete(sid);
              this.unlockedTools.delete(sid); // clean up unlock state
            }
          });
          
          // Set up handlers for this transport
          const sessionServer = new Server(
            {
              name: 'Fredo-mcp-server',
              version: '1.0.0',
            },
            {
              capabilities: {
                tools: {},
              },
            }
          );
          
          this.setupSessionHandlers(
            sessionServer,
            () => assignedSessionId
          );
          await sessionServer.connect(transport);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: No session ID provided');
          return;
        }
        
        // Handle the request with the transport
        await transport.handleRequest(req, res);
        return;
      }
      
      // Health check endpoint
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'OK', 
          type: 'MCP Server with SSE', 
          timestamp: new Date().toISOString(),
          tools: this.serviceLoader.getTools().length,
          services: this.serviceLoader.getServices().length,
          endpoints: {
            sse: '/sse',
            health: '/health',
            tools: '/tools'
          }
        }));
        return;
      }
      
      // Tools list endpoint
      if (url.pathname === '/tools' && req.method === 'GET') {
        const tools = this.serviceLoader.getTools().map(tool => ({
          name: tool.name,
          description: tool.description || `${tool.name} tool`,
          inputSchema: tool.inputSchema
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tools }));
        return;
      }
      
      // Root endpoint with information
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Fredo MCP Server</title>
              <style>
                body { font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 20px; }
                h1 { color: #9333ea; }
                code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
                pre { background: #1f2937; color: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; }
                .endpoint { margin: 20px 0; padding: 12px; background: #f9fafb; border-radius: 6px; }
                .endpoint a { color: #9333ea; text-decoration: none; font-weight: 600; }
                .endpoint a:hover { text-decoration: underline; }
              </style>
            </head>
            <body>
              <h1>🚀 Fredo MCP Server</h1>
              <p>Model Context Protocol server with SSE transport support</p>
              
              <h2>📡 Available Endpoints</h2>
              
              <div class="endpoint">
                <strong>MCP Endpoint (Streamable HTTP):</strong><br>
                <code>GET/POST/DELETE /sse</code><br>
                <small>Modern MCP Streamable HTTP transport<br>
                POST: Initialize and send messages | GET: Establish SSE stream | DELETE: Terminate session</small>
              </div>
              
              <div class="endpoint">
                <strong>Health Check:</strong><br>
                <a href="/health">/health</a><br>
                <small>Server status and metadata</small>
              </div>
              
              <div class="endpoint">
                <strong>Tools List:</strong><br>
                <a href="/tools">/tools</a><br>
                <small>Available MCP tools and their schemas</small>
              </div>
              
              <h2>📊 Server Status</h2>
              <ul>
                <li>Tools: ${this.serviceLoader.getTools().length}</li>
                <li>Services: ${this.serviceLoader.getServices().length}</li>
                <li>Transport: Streamable HTTP (protocol version 2025-06-18)</li>
              </ul>
              
              <h2>🔗 Connect Your AI Agent</h2>
              <p>Configure your AI agent to connect via SSE:</p>
              <pre>{
  "mcpServers": {
    "Fredo-tools": {
      "url": "http://localhost:${port}/sse"
    }
  }
}</pre>
            </body>
          </html>
        `);
        return;
      }
      
      // Active session polling endpoint — VS Code extension polls this to get the
      // connectionId scoped to the authenticated user's API key.
      if (url.pathname === '/api/session/active' && req.method === 'GET') {
        const sessionManager = SessionManager.getInstance();
        const connectionId = await sessionManager.getOrCreateActiveSession(0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectionId }));
        return;
      }
      
      // 404 for unknown paths
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    httpServer.listen(port, () => {
      console.error(`Fredo MCP Server started with SSE transport on port ${port}`);
      console.error(`- SSE endpoint: http://localhost:${port}/sse`);
      console.error(`- Web interface: http://localhost:${port}/`);
      console.error(`- Health check: http://localhost:${port}/health`);
      console.error(`- Tools list: http://localhost:${port}/tools`);
    });
  }
  
  /**
   * Set up handlers for a session server
   * @param sessionServer - the per-session MCP Server
   * @param getSessionId  - lazy getter for the session ID (resolved after onsessioninitialized)
   */
  private setupSessionHandlers(
    sessionServer: Server,
    getSessionId: () => string | undefined = () => undefined,
    getKeyId: () => number = () => 0
  ): void {
    // Handle tool listing
    sessionServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = this.serviceLoader.getTools();
      
      // Per-session unlock set (empty until tool_search unlocks tools)
      const sid = getSessionId();
      const unlocked = sid ? (this.unlockedTools.get(sid) ?? new Set<string>()) : new Set<string>();

      // Filter tools: only expose those with exposedAs === 'mcp' or 'both'
      // AND that are not deferred (or have already been unlocked)
      const mcpTools = allTools.filter(tool => {
        const exposedAs = tool.exposedAs || 'both';
        if (exposedAs !== 'mcp' && exposedAs !== 'both') return false;
        if ((tool.deferLoading ?? false) && !unlocked.has(tool.name)) return false;
        return true;
      });
      
      const tools = mcpTools.map(tool => {
        const inputSchema = tool.inputSchema || {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Query parameters for the tool'
            }
          },
          required: []
        };

        return {
          name: tool.name,
          description: tool.description || `${tool.name} tool`,
          inputSchema
        };
      });

      console.log(`[MCPServer sessionHandler] Exposing ${tools.length} tools via MCP SSE (filtered from ${allTools.length} total)`);
      return { tools };
    });

    // Handle tool execution
    sessionServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      const tool = this.serviceLoader.getTool(name);
      if (!tool) {
        throw new Error(`Tool ${name} not found`);
      }

      // Check if tool is exposed via MCP
      const exposedAs = tool.exposedAs || 'both';
      console.log(`[MCPServer sessionHandler] Tool ${name} execution check: exposedAs=${exposedAs}`);
      
      if (exposedAs === 'api') {
        throw new Error(`Tool ${name} is only available via API, not MCP`);
      }

      try {
        // Auto-create or get the active session — no handshake call required
        const sessionManager = SessionManager.getInstance();
        const connectionIdForTool = await sessionManager.getOrCreateActiveSession(getKeyId());

        console.error(`[MCPServer sessionHandler] Tool ${name} executing with connectionId: ${connectionIdForTool}`);
        
        const context = { sseConnectionId: connectionIdForTool, transport: 'mcp', unlockTool: (toolName: string) => this.unlockTool(connectionIdForTool, toolName) };

        const shouldPublishDevMode = name !== 'tools_documentation'
          && name !== 'k8s_diagram'
          && !name.startsWith('kubectl_')
          && name !== 'fredo_ui_alert'
          && name !== 'fredo_ui_stepper';

        const { StreamPublisher } = await import('../lib/stream-publisher/StreamPublisher.js');
        const publisher = StreamPublisher.getInstance();

        if (shouldPublishDevMode) {
          await publisher.publishToDevMode({ toolName: name, sessionId: connectionIdForTool, state: 'Init', input: args });
        }

        const result = await tool.execute(args || {}, context);

        if (shouldPublishDevMode) {
          await publisher.publishToDevMode({ toolName: name, sessionId: connectionIdForTool, state: 'Response', response: result });
        }
        
        // Check for UI responses from browser extension
        const uiResponses = await this.checkUIResponses(connectionIdForTool);
        
        // Compact JSON to LLM; short-circuit empty results to avoid raw [] in context
        let responseText: string;
        if (typeof result === 'string') {
          responseText = result;
        } else if (Array.isArray(result) && result.length === 0) {
          responseText = 'No results found for the given query.';
        } else if (result !== null && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0) {
          responseText = 'No results found.';
        } else {
          responseText = JSON.stringify(result);
        }

        // Append UI responses if any exist
        if (uiResponses.length > 0) {
          responseText = `${responseText}\n\n📬 UI Responses:\n${JSON.stringify({ uiResponses: uiResponses })}`;
        }

        // Hard cap: prevent any single tool response from exceeding ~4K tokens.
        const MAX_RESPONSE_CHARS = 15_000;
        if (responseText.length > MAX_RESPONSE_CHARS) {
          const originalLength = responseText.length;
          responseText = responseText.slice(0, MAX_RESPONSE_CHARS) + `…[truncated: ${originalLength} chars total]`;
          console.error(`[MCPServer sessionHandler] Response for ${name} truncated: ${originalLength} → ${MAX_RESPONSE_CHARS} chars`);
        }

        return {
          content: [
            {
              type: 'text',
              text: responseText
            }
          ]
        };
      } catch (error) {
        const { StreamPublisher } = await import('../lib/stream-publisher/StreamPublisher.js');
        const publisher = StreamPublisher.getInstance();
        const sessionManager = SessionManager.getInstance();
        const connectionId = sessionManager.getActiveConnectionId(getKeyId()) || sessionManager.getCurrentSessionId();
        const shouldPublishDevMode = name !== 'tools_documentation'
          && name !== 'k8s_diagram'
          && !name.startsWith('kubectl_')
          && name !== 'fredo_ui_alert'
          && name !== 'fredo_ui_stepper';
        if (shouldPublishDevMode && connectionId) {
          await publisher.publishToDevMode({ toolName: name, sessionId: connectionId, state: 'Error', error: { message: error instanceof Error ? error.message : 'Unknown error' } });
        }
        throw new Error(`Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });
  }

  /**
   * Get server instance for testing
   */
  getServer(): Server {
    return this.server;
  }
}