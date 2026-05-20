import { BaseService } from '../../core/BaseService.js';
import * as KubectlModel from './model.js';
import { KubectlRepository } from './repository.js';
import { KubectlController } from './controller.js';
import { kubectlRoutes } from './routes.js';

/**
 * Kubectl Service
 * Provides kubectl operations via MCP tools using Kubernetes API client
 */
export class KubectlService extends BaseService {
  readonly name = 'kubectl';
  readonly model = KubectlModel;
  readonly repository: KubectlRepository;
  readonly controller: KubectlController;
  readonly routes = kubectlRoutes;

  constructor() {
    super();
    this.repository = new KubectlRepository();
    this.controller = new KubectlController(this.repository);
  }

  async init(): Promise<void> {
    // Store service instance globally for tools
    globalThis.__kubectlService = this;
    console.log('[KubectlService] Service initialized - Kubernetes client ready');
  }

  registerRoutes(): void {
    console.log(`[KubectlService] Registering routes for ${this.name} service`);
  }
}

export default KubectlService;
