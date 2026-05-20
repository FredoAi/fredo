import { BaseService } from '../../core/BaseService.js';
import type { BaseTool } from '../../core/BaseTool.js';
import { AzdoStartWorkitemTool } from './tools/azdo_start_workitem/AzdoStartWorkitemTool.js';
import { AzdoCreateWorkitemTool } from './tools/azdo_create_workitem/AzdoCreateWorkitemTool.js';

export class AzdoWorkitemsService extends BaseService {
  readonly name = 'azdo-workitems';
  readonly description = 'Azure DevOps work items integration for Atlas UI';
  
  // No routes needed - MCP only
  readonly routes = null;
  
  // Simple service - no model/repository/controller
  readonly model = null;
  readonly repository = null;
  readonly controller = null;

  async init(): Promise<void> {
    console.log('[AzdoWorkitemsService] Initialized');
  }

  registerRoutes(): void {
    // No routes to register - MCP only
  }

  getTools(): BaseTool[] {
    return [
      new AzdoStartWorkitemTool(),
      new AzdoCreateWorkitemTool()
    ];
  }
}
