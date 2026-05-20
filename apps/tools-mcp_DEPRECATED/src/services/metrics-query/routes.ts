import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

/**
 * Metrics Query Service Routes
 */
export class MetricsQueryRoutes extends BaseRoutes {
  protected serviceName = 'metrics-query';
  protected serviceInstance: any;
  protected autoRegisterTools = true; // Enable auto-route generation from tools

  async register(_fastify: FastifyInstance, options: any): Promise<void> {
    const metricsQueryService = options['metrics-queryService'];
    this.serviceInstance = metricsQueryService;

    // Auto-generated route from tool's httpEndpoint will handle POST /query
  }
}

/**
 * Backwards compatibility export
 */
const metricsQueryRoutesInstance = new MetricsQueryRoutes();

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  await metricsQueryRoutesInstance.register(fastify, options);
}

export default metricsQueryRoutesInstance;
