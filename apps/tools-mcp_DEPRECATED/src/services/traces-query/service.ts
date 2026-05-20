import { BaseService } from '../../core/BaseService.js';
import * as TracesQueryModel from './model.js';
import { TracesQueryRepository } from './repository.js';
import { TracesQueryController } from './controller.js';
import * as tracesQueryRoutes from './routes.js';

/**
 * Traces Query Service
 * Provides query access to the traces table via REST API and MCP tools
 */
export class TracesQueryService extends BaseService {
  readonly name = 'traces-query';
  readonly model = TracesQueryModel;
  readonly repository: TracesQueryRepository;
  readonly controller: TracesQueryController;
  readonly routes = tracesQueryRoutes;

  constructor() {
    super();
    this.repository = new TracesQueryRepository();
    this.controller = new TracesQueryController(this.repository);
  }

  async init(): Promise<void> {
    console.log('Traces Query Service initialized');
    await this.repository.init();
  }

  registerRoutes(): void {
    console.log(`Registering routes for ${this.name} service`);
  }
}

export default TracesQueryService;
