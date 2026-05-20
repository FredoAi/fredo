import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';
import type { CodeExecuteRequest } from './model.js';

export class CodeExecutionRoutes extends BaseRoutes {
  protected serviceName = 'code-execution';
  protected serviceInstance: any;

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    this.serviceInstance = options['code-executionService'];

    fastify.route(this.createRoute({
      method: 'POST',
      url: '/execute',
      schema: {
        description: 'Execute code in an isolated sandbox container',
        tags: ['code-execution'],
        body: {
          type: 'object',
          required: ['code', 'language'],
          properties: {
            code:         { type: 'string' },
            language:     { type: 'string', enum: ['python', 'javascript', 'typescript', 'go', 'java', 'r'] },
            libraries:    { type: 'array', items: { type: 'string' } },
            timeout_ms:   { type: 'number', default: 30000 },
            enable_tools: { type: 'boolean', default: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success:            { type: 'boolean' },
              exit_code:          { type: 'number' },
              stdout:             { type: 'string' },
              stderr:             { type: 'string' },
              execution_time_ms:  { type: 'number' },
              language:           { type: 'string' },
            },
          },
        },
      },
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CodeExecuteRequest;
        const result = await this.serviceInstance.controller.execute(body);
        reply.send(result);
      },
    }));
  }
}

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  const routes = new CodeExecutionRoutes();
  await routes.register(fastify, options);
}
