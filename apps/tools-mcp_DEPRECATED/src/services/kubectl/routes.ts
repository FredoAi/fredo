import { BaseRoutes } from '../../core/BaseRoutes.js';
import type { FastifyInstance } from 'fastify';

/**
 * Kubectl Routes
 * No REST API routes - kubectl operations are MCP-only
 */
export class KubectlRoutes extends BaseRoutes {
  protected serviceName = 'kubectl';

  async register(_fastify: FastifyInstance, _options: any): Promise<void> {
    // All kubectl operations are exposed via MCP tools only
    // No REST API endpoints needed
  }
}

export const kubectlRoutes = new KubectlRoutes();
