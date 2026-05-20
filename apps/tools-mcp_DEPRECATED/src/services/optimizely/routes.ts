import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

/**
 * Optimizely Service Routes
 * Exposes flag read operations via REST API at /api/v1/optimizely/*
 * Flag updates are MCP-only and not exposed here.
 */
export class OptimizelyRoutes extends BaseRoutes {
  protected serviceName = 'optimizely';

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    const optimizelyService = options['optimizelyService'];

    // ──────────────────────────────────────────────────────────────────────────
    // GET /api/v1/optimizely/flags  — All feature flags
    // ──────────────────────────────────────────────────────────────────────────
    const getFlagsRoute = this.createRoute({
      method: 'GET',
      url: '/flags',
      schema: {
        description: 'Get all Optimizely feature flags with their current status',
        tags: ['optimizely'],
        querystring: {
          type: 'object',
          properties: {
            environment: {
              type: 'string',
              enum: ['production', 'staging', 'development'],
              description: 'Filter flags by environment',
            },
            statusFilter: {
              type: 'string',
              enum: ['enabled', 'disabled', 'all'],
              description: 'Filter by enabled/disabled status (default: all)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              flags: { type: 'array' },
              total: { type: 'integer' },
              isMockData: { type: 'boolean' },
            },
          },
        },
      },
      handler: async (request: any, reply) => {
        const result = await optimizelyService.controller.getFlags({
          environment: request.query.environment,
          statusFilter: request.query.statusFilter,
        });
        return reply.send(result);
      },
    });

    fastify.route(getFlagsRoute);
  }
}

export const optimizelyRoutes = new OptimizelyRoutes();
