/**
 * Global namespace extensions for Atlas Tools MCP
 * 
 * This file declares custom properties added to the global scope
 * for service instances that need to be accessed by MCP tools.
 */

import type { KubectlService } from '../../services/kubectl/service.js';
import type { InfrastructureService } from '../../services/infrastructure-diagram/service.js';
import type { JiraService } from '../../services/jira/service.js';
import type { OptimizelyService } from '../../services/optimizely/service.js';

declare global {
  /**
   * Global service instances for MCP tool access
   * These are set during service initialization
   */
  var __kubectlService: KubectlService | undefined;
  var __infraService: InfrastructureService | undefined;
  var __jiraService: JiraService | undefined;
  var __optimizelyService: OptimizelyService | undefined;
}

export {};
