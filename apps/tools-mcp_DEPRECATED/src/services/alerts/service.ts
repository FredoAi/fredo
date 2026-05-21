import { BaseService } from '../../core/BaseService.js';
import type { BaseTool } from '../../core/BaseTool.js';
import { FredoUiAlertTool } from './tools/fredo_ui_alert/FredoUiAlertTool.js';

export class AlertsService extends BaseService {
  readonly name = 'alerts';
  readonly routes = null; // No routes - alerts use generic fredo-ui/response endpoint
  
  // Required by BaseService but not used for this simple service
  readonly model = null;
  readonly repository = null;
  readonly controller = null;

  async init(): Promise<void> {
    console.log('[AlertsService] Initialized');
  }

  registerRoutes(): void {
    console.log(`[AlertsService] Registering routes for ${this.name} service`);
  }

  getTools(): BaseTool[] {
    return [
      new FredoUiAlertTool(this)
    ];
  }

  /**
   * Get alert tool instance
   */
  getAlertTool(): FredoUiAlertTool {
    return new FredoUiAlertTool(this);
  }
}

