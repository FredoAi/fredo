#!/usr/bin/env node

/**
 * MCP Server Entry Point for Fredo
 * 
 * This script starts the Fredo services as an MCP server,
 * exposing all tools via the Model Context Protocol.
 * 
 * Usage: node mcp-server.js
 */

import { ServiceLoader } from './core/loader.js';
import { MCPServer } from './core/mcpServer.js';
import { StreamPublisher } from './lib/stream-publisher/StreamPublisher.js';
import { SessionManager } from './core/SessionManager.js';
import { RedisStreamConfig } from './core/types/StreamEvent.js';

async function startMCPServer(): Promise<void> {
  try {
    console.error('Starting Fredo MCP Server...');
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    const useSSE = args.includes('--sse') || args.includes('--http');
    const transportType = useSSE ? 'sse' : 'stdio';
    const portArg = args.find(arg => arg.startsWith('--port='));
    const port = portArg ? parseInt(portArg.split('=')[1]) : 3001;
    
    // Initialize Redis configuration
    const redisConfig: RedisStreamConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      streamKeyPattern: 'fredo:sessions:{sessionId}:events',
      maxLength: 1000,
      ttl: 24 * 60 * 60 // 24 hours
    };

    console.error('🔴 Initializing Redis Stream Publisher...');
    const publisher = StreamPublisher.getInstance(redisConfig);
    await publisher.connect();
    console.error('✅ Redis Stream Publisher connected');

    console.error('🔴 Initializing Session Manager...');
    const sessionManager = SessionManager.getInstance();
    sessionManager.initializeRedis(redisConfig);
    console.error('✅ Session Manager initialized with Redis config');
    
    // Load all services and their tools
    const serviceLoader = new ServiceLoader();
    await serviceLoader.loadServices();
    
    const tools = serviceLoader.getTools();
    const services = serviceLoader.getServices();
    
    console.error(`Loaded ${services.length} services with ${tools.length} tools:`);
    for (const tool of tools) {
      console.error(`  - ${tool.name}: ${tool.description || 'No description'}`);
    }
    
    // Create and start MCP server
    const mcpServer = new MCPServer(serviceLoader);
    await mcpServer.start(transportType, port);
    
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Only auto-start when run directly; skip when embedded inside VS Code extension
if (process.env.FREDO_EMBEDDED !== 'true') {
  startMCPServer();
}

export { startMCPServer };