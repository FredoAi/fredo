/**
 * Atlas Code Sandbox — MCP Server
 *
 * Exposes a single MCP tool: code_execute
 * Also runs a Unix socket server so code running inside the sandbox can call
 * back to Atlas tools via the Bun tool bridge.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import * as http from 'http';
import { CodeExecuteTool } from './tools/code_execute/CodeExecuteTool.js';

const PORT = parseInt(process.env.CODE_SANDBOX_PORT ?? '3003', 10);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const codeExecuteTool = new CodeExecuteTool();

function buildMcpServer(): Server {
  const server = new Server(
    { name: 'Atlas-code-sandbox', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: codeExecuteTool.name,
        description: codeExecuteTool.description,
        inputSchema: codeExecuteTool.inputSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== codeExecuteTool.name) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const result = await codeExecuteTool.execute(args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  return server;
}

async function startSseServer(): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'code-sandbox' }));
      return;
    }

    if (url.pathname === '/sse') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (req.method === 'POST') {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
          onsessionclosed: (sid) => {
            transports.delete(sid);
          },
        });

        const sessionServer = buildMcpServer();
        await sessionServer.connect(transport);
      } else {
        res.writeHead(400).end('Bad Request');
        return;
      }

      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404).end('Not Found');
  });

  httpServer.listen(PORT, () => {
    console.log(`[code-sandbox] MCP SSE server listening on port ${PORT}`);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const transport = process.env.CODE_SANDBOX_TRANSPORT ?? 'sse';

if (transport === 'stdio') {
  const server = buildMcpServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error('[code-sandbox] stdio transport started');
} else {
  await startSseServer();
}
