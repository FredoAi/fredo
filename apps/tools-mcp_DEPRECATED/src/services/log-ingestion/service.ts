import { BaseService } from '../../core/BaseService.js';
import * as LogIngestionModel from './model.js';
import { LogIngestionRepository } from './repository.js';
import { LogIngestionController } from './controller.js';
import * as logIngestionRoutes from './routes.js';

/**
 * Log Ingestion Service
 * Receives OTLP log batches and stores them in application_logs table
 */
export class LogIngestionService extends BaseService {
  readonly name = 'log-ingestion';
  readonly model = LogIngestionModel;
  readonly repository: LogIngestionRepository;
  readonly controller: LogIngestionController;
  readonly routes = logIngestionRoutes;

  constructor() {
    super();
    this.repository = new LogIngestionRepository();
    this.controller = new LogIngestionController(this.repository);
  }

  async init(): Promise<void> {
    console.log('Log Ingestion Service initialized');
    await this.repository.init();
  }

  registerRoutes(): void {
    console.log(`Registering routes for ${this.name} service`);
  }
}

export default LogIngestionService;
