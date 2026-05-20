import { BaseService } from '../../core/BaseService.js';
import * as MetricsQueryModel from './model.js';
import { MetricsQueryRepository } from './repository.js';
import { MetricsQueryController } from './controller.js';
import * as metricsQueryRoutes from './routes.js';

/**
 * Metrics Query Service
 * Provides query access to the metrics table via REST API and MCP tools
 */
export class MetricsQueryService extends BaseService {
  readonly name = 'metrics-query';
  readonly model = MetricsQueryModel;
  readonly repository: MetricsQueryRepository;
  readonly controller: MetricsQueryController;
  readonly routes = metricsQueryRoutes;

  constructor() {
    super();
    this.repository = new MetricsQueryRepository();
    this.controller = new MetricsQueryController(this.repository);
  }

  async init(): Promise<void> {
    console.log('Metrics Query Service initialized');
    await this.repository.init();
  }

  registerRoutes(): void {
    console.log(`Registering routes for ${this.name} service`);
  }
}

export default MetricsQueryService;
