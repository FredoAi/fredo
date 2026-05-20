import { FastifyInstance, FastifyRequest } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';
import { LogIngestionService } from './service.js';
import { ExportLogsServiceRequest } from './model.js';

export class LogIngestionRoutes extends BaseRoutes {
  protected serviceName = 'log-ingestion';

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    // Get the service instance injected by Router
    const service = options['log-ingestionService'] as LogIngestionService;

    const route = this.createRoute({
      method: 'POST',
      url: '/v1/logs',
      schema: {
        description: 'Ingest OTLP logs',
        tags: ['ingestion'],
        body: {
          type: 'object',
          description: 'OTLP ExportLogsServiceRequest JSON',
          additionalProperties: true
        },
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' }
            }
          }
        }
      },
      handler: async (request: FastifyRequest) => {
        const batch = request.body as ExportLogsServiceRequest;
        console.log('[LogIngestionRoutes] Received batch with resourceLogs:', batch?.resourceLogs?.length || 'undefined');
        await service.controller.processLogBatch(batch);
        return { status: 'success' };
      }
    });

    fastify.route(route);
  }
}

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  const routes = new LogIngestionRoutes();
  await routes.register(fastify, options);
}
