import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

/**
 * Logs Query Service Routes
 */
export class LogsQueryRoutes extends BaseRoutes {
  protected serviceName = 'logs-query';
  protected serviceInstance: any;
  protected autoRegisterTools = true; // Enable auto-route generation from tools

  async register(_fastify: FastifyInstance, options: any): Promise<void> {
    const logsQueryService = options['logs-queryService'];
    this.serviceInstance = logsQueryService;

    // Auto-generated route from tool's httpEndpoint will handle POST /query
    // Manual route commented out to test auto-generation
    
    /*
    const queryRoute = this.createRoute({
      method: 'POST',
      url: '/query',
      schema: {
        description: 'Execute read-only SQL queries against the logs table',
        tags: ['logs-query'],
        body: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { 
              type: 'string',
              description: 'SELECT query to execute (INSERT/UPDATE/DELETE blocked)'
            }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              row_count: { type: 'integer', description: 'Number of rows returned' },
              rows: { 
                type: 'array',
                description: 'Query results'
              }
            }
          }
        }
      },
      handler: async (request: any, reply) => {
        const { query } = request.body;
        const result = await logsQueryService.controller.executeQuery({ query });
        return reply.send(result);
      }
    });

    fastify.route(queryRoute);
    */
  }
}

/**
 * Backwards compatibility export
 */
const logsQueryRoutesInstance = new LogsQueryRoutes();

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  await logsQueryRoutesInstance.register(fastify, options);
}

export default logsQueryRoutesInstance;
