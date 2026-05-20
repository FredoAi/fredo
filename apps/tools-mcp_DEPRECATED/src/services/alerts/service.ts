import { BaseService } from '../../core/BaseService.js';
import type { BaseTool } from '../../core/BaseTool.js';
import { AtlasUiAlertTool } from './tools/atlas_ui_alert/AtlasUiAlertTool.js';

/**
 * Alerts Service
 * Handles UI alerts and user confirmations via event-based communication
 */
export class AlertsService extends BaseService {
  readonly name = 'alerts';
  readonly routes = null; // No routes - alerts use generic atlas-ui/response endpoint
  
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
      new AtlasUiAlertTool(this)
    ];
  }

  /**
   * Get alert tool instance
   */
  getAlertTool(): AtlasUiAlertTool {
    return new AtlasUiAlertTool(this);
  }
}

