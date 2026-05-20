import { BaseService } from '../../core/BaseService.js';
import * as ToolsDocumentationModel from './model.js';
import { ToolsDocumentationRepository } from './repository.js';
import { ToolsDocumentationController } from './controller.js';
import { toolsDocumentationRoutes } from './routes.js';

/**
 * Tools Documentation Service
 * Provides access to tool documentation via REST API and MCP tools
 */
export class ToolsDocumentationService extends BaseService {
  readonly name = 'tools-documentation';
  readonly model = ToolsDocumentationModel;
  readonly repository: ToolsDocumentationRepository;
  readonly controller: ToolsDocumentationController;
  readonly routes = toolsDocumentationRoutes;

  constructor() {
    super();
    this.repository = new ToolsDocumentationRepository();
    this.controller = new ToolsDocumentationController(this.repository);
  }

  async init(): Promise<void> {
    console.log('Tools Documentation Service initialized');
    await this.repository.init();
  }

  registerRoutes(): void {
    console.log(`Registering routes for ${this.name} service`);
  }

  /**
   * Set the tool metadata from ServiceLoader
   * Called after all services are loaded
   */
  setToolMetadata(metadata: Map<string, { serviceName: string; folderPath: string }>): void {
    this.repository.setToolMetadata(metadata);
  }

  /**
   * Inject the full ServiceLoader reference so ToolSearchTool can access all tools.
   * Called by loader.ts after every service has been loaded.
   */
  setServiceLoader(loader: { getTools(): any[]; getTool(name: string): any }): void {
    const toolSearchTool = loader.getTool('tool_search') as any;
    if (toolSearchTool && typeof toolSearchTool.setTools === 'function') {
      toolSearchTool.setTools(loader.getTools());
    }
  }
}

export default ToolsDocumentationService;

