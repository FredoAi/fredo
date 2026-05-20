import { BaseService } from '../../core/BaseService.js';
import * as LogsQueryModel from './model.js';
import { LogsQueryRepository } from './repository.js';
import { LogsQueryController } from './controller.js';
import * as logsQueryRoutes from './routes.js';

/**
 * Logs Query Service
 * Provides query access to the logs table via REST API and MCP tools
 */
export class LogsQueryService extends BaseService {
  readonly name = 'logs-query';
  readonly model = LogsQueryModel;
  readonly repository: LogsQueryRepository;
  readonly controller: LogsQueryController;
  readonly routes = logsQueryRoutes;

  constructor() {
    super();
    this.repository = new LogsQueryRepository();
    this.controller = new LogsQueryController(this.repository);
  }

  async init(): Promise<void> {
    console.log('Logs Query Service initialized');
    await this.repository.init();
  }

  registerRoutes(): void {
    console.log(`Registering routes for ${this.name} service`);
  }
}

export default LogsQueryService;
