import { BaseService } from '../../core/BaseService.js';
import type { BaseTool } from '../../core/BaseTool.js';
import * as CodeExecutionModel from './model.js';
import { CodeExecutionRepository } from './repository.js';
import { CodeExecutionController } from './controller.js';
import * as codeExecutionRoutes from './routes.js';
import { CodeExecuteTool } from './tools/code_execute/CodeExecuteTool.js';

export class CodeExecutionService extends BaseService {
  readonly name = 'code-execution';
  readonly model = CodeExecutionModel;
  readonly repository: CodeExecutionRepository;
  readonly controller: CodeExecutionController;
  readonly routes = codeExecutionRoutes;

  constructor() {
    super();
    this.repository = new CodeExecutionRepository();
    this.controller = new CodeExecutionController(this.repository);
  }

  async init(): Promise<void> {
    await this.repository.init();
    console.log('[CodeExecutionService] Initialized');
  }

  registerRoutes(): void {
    console.log(`[CodeExecutionService] Registering routes for ${this.name} service`);
  }

  getTools(): BaseTool[] {
    return [new CodeExecuteTool(this)];
  }
}

export default CodeExecutionService;
