import { BaseService } from '../../core/BaseService.js';
import type { BaseTool } from '../../core/BaseTool.js';
import * as OptimizelyModel from './model.js';
import { OptimizelyRepository } from './repository.js';
import { OptimizelyController } from './controller.js';
import { optimizelyRoutes } from './routes.js';
import { OptimizelyGetFlagsTool } from './tools/optimizely_get_flags/OptimizelyGetFlagsTool.js';
import { OptimizelyUpdateFlagTool } from './tools/optimizely_update_flag/OptimizelyUpdateFlagTool.js';

export class OptimizelyService extends BaseService {
  readonly name = 'optimizely';
  readonly model = OptimizelyModel;
  readonly repository: OptimizelyRepository;
  readonly controller: OptimizelyController;
  readonly routes = optimizelyRoutes;

  constructor() {
    super();
    this.repository = new OptimizelyRepository();
    this.controller = new OptimizelyController(this.repository);
  }

  async init(): Promise<void> {
    globalThis.__optimizelyService = this;
  }

  registerRoutes(): void {}

  getTools(): BaseTool[] {
    return [
      new OptimizelyGetFlagsTool(),
      new OptimizelyUpdateFlagTool(),
    ];
  }
}
