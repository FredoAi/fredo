import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

/**
 * Traces Query Service Routes
 */
export class TracesQueryRoutes extends BaseRoutes {
  protected serviceName = 'traces-query';
  protected serviceInstance: any;
  protected autoRegisterTools = true; // Enable auto-route generation from tools

  async register(_fastify: FastifyInstance, options: any): Promise<void> {
    const tracesQueryService = options['traces-queryService'];
    this.serviceInstance = tracesQueryService;

    // Auto-generated route from tool's httpEndpoint will handle POST /query
  }
}

/**
 * Backwards compatibility export
 */
const tracesQueryRoutesInstance = new TracesQueryRoutes();

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  await tracesQueryRoutesInstance.register(fastify, options);
}

export default tracesQueryRoutesInstance;
