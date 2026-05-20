import { FastifyInstance } from 'fastify';
import { BaseService } from './BaseService';
import { ServiceLoader } from './loader.js';

/**
 * Auto-registers all service routes and tool endpoints
 */
export class Router {
  private fastify: FastifyInstance;
  private serviceLoader?: ServiceLoader;
  
  constructor(fastify: FastifyInstance, serviceLoader?: ServiceLoader) {
    this.fastify = fastify;
    this.serviceLoader = serviceLoader;
  }

  /**
   * Register routes for all services
   */
  async registerServiceRoutes(services: BaseService[]): Promise<void> {
    for (const service of services) {
      // Let each service register its own routes
      service.registerRoutes();
      
      // Register the service's routes with Fastify
      await this.registerServiceWithFastify(service);
    }
  }

  /**
   * Register a single service with Fastify
   */
  private async registerServiceWithFastify(service: BaseService): Promise<void> {
    // Register service-specific routes defined in service.routes
    if (service.routes && typeof service.routes.register === 'function') {
      const serviceOptions: any = { [`${service.name}Service`]: service };
      const serviceRoutes = service.routes;
      
      // Use default export if available (class instance), otherwise use the module
      const routesInstance = (service.routes as any).default || service.routes;
      
      // Pass tools to routes for auto-generation
      if (this.serviceLoader && typeof routesInstance.setTools === 'function') {
        const tools = this.serviceLoader.getToolsForService(service.name);
        console.log(`[Router] Setting ${tools.length} tools for ${service.name}`);
        routesInstance.setTools(tools);
      }
      
      // Create a plugin to handle both auto-generated and manual routes
      await this.fastify.register(async (fastify: FastifyInstance) => {
        // Auto-register routes from tools first (if enabled)
        if (typeof routesInstance.autoRegisterToolRoutes === 'function') {
          console.log(`[Router] Calling autoRegisterToolRoutes for ${service.name}`);
          await routesInstance.autoRegisterToolRoutes(fastify);
        }
        
        // Then register manual routes (can override auto-generated ones)
        await serviceRoutes.register(fastify, serviceOptions);
      }, {
        prefix: `/api/v1/${service.name}`
      });
    }
  }

  /**
   * Register MCP server endpoints (placeholder for real MCP implementation)
   */
  async registerMCPRoutes(): Promise<void> {
    // MCP server will be implemented separately
    // Real MCP tools will be exposed via MCP protocol, not REST endpoints
  }

  /**
   * Register health check endpoint
   */
  async registerHealthRoutes(services: BaseService[]): Promise<void> {
    this.fastify.get('/health', async (_request: any, reply: any) => {
      const serviceStatuses = await Promise.all(
        services.map(async (service) => ({
          name: service.name,
          status: 'healthy', // TODO: Implement proper health checks
          initialized: true
        }))
      );

      return reply.send({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        services: serviceStatuses,
        uptime: process.uptime()
      });
    });
  }
}