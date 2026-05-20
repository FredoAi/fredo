import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';
import { InfrastructureDiagramService } from './service.js';

/**
 * Infrastructure Diagram Routes
 */
export class InfrastructureDiagramRoutes extends BaseRoutes {
  protected serviceName = 'infrastructure-diagram';
  protected serviceInstance!: InfrastructureDiagramService;
  protected autoRegisterTools = true; // Enable auto-route generation from tools' httpEndpoint

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    this.serviceInstance = options['infrastructure-diagramService'];
    
    // Routes are auto-registered from tools' httpEndpoint property
    // No manual route definitions needed - httpEndpoint handles:
    // - GET /snapshot (infrastructure_snapshot tool)
    // - GET /stream-url (infrastructure_stream tool - returns SSE URL)
    
    // The actual SSE stream endpoint still needs manual registration:
    const streamRoute = this.createRoute({
      method: 'GET',
      url: '/stream',
      schema: {
        description: 'Subscribe to real-time infrastructure graph updates via SSE',
        tags: ['infrastructure-diagram'],
        response: {
          200: {
            description: 'Server-Sent Events stream',
            type: 'string',
          },
        },
      },
      handler: async (request, reply) => {
        // Force HTTP/1.1 for SSE compatibility (HTTP/2 can cause issues with long-lived streams)
        if (request.raw.httpVersion === '2.0') {
          reply.header('Connection', 'keep-alive');
        }
        
        // Hijack and set SSE headers
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

        // Send initial connection message
        reply.raw.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

        // Set up event listener
        const updateHandler = (update: any) => {
          reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
        };

        this.serviceInstance.on('graph:update', updateHandler);

        // Heartbeat
        const heartbeat = setInterval(() => {
          reply.raw.write(`: heartbeat\n\n`);
        }, 30000);

        // Cleanup on disconnect
        request.raw.on('close', () => {
          clearInterval(heartbeat);
          this.serviceInstance.removeListener('graph:update', updateHandler);
          reply.raw.end();
        });
      },
    });

    // Register only the SSE stream endpoint (not auto-registerable)
    fastify.route(streamRoute);
  }
}

/**
 * Backwards compatibility export
 */
const infrastructureDiagramRoutesInstance = new InfrastructureDiagramRoutes();

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  await infrastructureDiagramRoutesInstance.register(fastify, options);
}

export default infrastructureDiagramRoutesInstance;
