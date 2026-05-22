/**
 * EmbeddedServiceLoader — static service + tool registry for bundled (embedded) mode.
 *
 * The standard ServiceLoader uses fs.readdir() + dynamic import(fileUrl) to
 * discover services and tools at runtime.  This is incompatible with esbuild
 * bundling because the paths are runtime-computed strings.
 *
 * EmbeddedServiceLoader statically imports all services and tools so esbuild
 * can include them in the bundle.  The public API mirrors ServiceLoader so the
 * rest of the codebase (MCPServer, Router, embedded.ts) can use either
 * interchangeably.
 */

import { BaseService } from './BaseService.js';
import { BaseTool } from './BaseTool.js';

// ── Services ──────────────────────────────────────────────────────────────── //
import { AlertsService } from '../services/alerts/service.js';
import { FredoUiService } from '../services/fredo-ui/FredoUiService.js';
import { AzdoWorkitemsService } from '../services/azdo-workitems/service.js';
import { CodeExecutionService } from '../services/code-execution/service.js';
import { DevModeService } from '../services/dev-mode/service.js';
import { InfrastructureDiagramService } from '../services/infrastructure-diagram/service.js';
import { JiraService } from '../services/jira/service.js';
import { KubectlService } from '../services/kubectl/service.js';
import { LogIngestionService } from '../services/log-ingestion/service.js';
import { LogsQueryService } from '../services/logs-query/service.js';
import { MetricsQueryService } from '../services/metrics-query/service.js';
import { OptimizelyService } from '../services/optimizely/service.js';
import { ToolsDocumentationService } from '../services/tools-documentation/service.js';
import { TracesQueryService } from '../services/traces-query/service.js';

// ── Tools ─────────────────────────────────────────────────────────────────── //
// alerts
import { FredoUiAlertTool } from '../services/alerts/tools/fredo_ui_alert/FredoUiAlertTool.js';
// fredo-ui
import { FredoUiCollectResponsesTool } from '../services/fredo-ui/tools/fredo_ui_collect_responses/FredoUiCollectResponsesTool.js';
import { FredoUiStepperTool } from '../services/fredo-ui/tools/fredo_ui_stepper/FredoUiStepperTool.js';
// azdo-workitems
import { AzdoCreateWorkitemTool } from '../services/azdo-workitems/tools/azdo_create_workitem/AzdoCreateWorkitemTool.js';
import { AzdoStartWorkitemTool } from '../services/azdo-workitems/tools/azdo_start_workitem/AzdoStartWorkitemTool.js';
// code-execution
import { CodeExecuteTool } from '../services/code-execution/tools/code_execute/CodeExecuteTool.js';
// infrastructure-diagram
import { InfrastructureSnapshotTool } from '../services/infrastructure-diagram/tools/infrastructure_snapshot/InfrastructureSnapshotTool.js';
import { InfrastructureStreamTool } from '../services/infrastructure-diagram/tools/infrastructure_stream/InfrastructureStreamTool.js';
// jira
import { JiraCreateIssueTool } from '../services/jira/tools/jira_create_issue/JiraCreateIssueTool.js';
import { JiraGetIssueDetailsTool } from '../services/jira/tools/jira_get_issue_details/JiraGetIssueDetailsTool.js';
import { JiraGetMyIssuesTool } from '../services/jira/tools/jira_get_my_issues/JiraGetMyIssuesTool.js';
// kubectl
import { KubectlDeletePodTool } from '../services/kubectl/tools/kubectl_delete_pod/KubectlDeletePodTool.js';
import { KubectlDescribePodTool } from '../services/kubectl/tools/kubectl_describe_pod/KubectlDescribePodTool.js';
import { KubectlExecTool } from '../services/kubectl/tools/kubectl_exec/KubectlExecTool.js';
import { KubectlGetDeploymentsTool } from '../services/kubectl/tools/kubectl_get_deployments/KubectlGetDeploymentsTool.js';
import { KubectlGetEventsTool } from '../services/kubectl/tools/kubectl_get_events/KubectlGetEventsTool.js';
import { KubectlGetPodsTool } from '../services/kubectl/tools/kubectl_get_pods/KubectlGetPodsTool.js';
import { KubectlGetServicesTool } from '../services/kubectl/tools/kubectl_get_services/KubectlGetServicesTool.js';
import { KubectlLogsTool } from '../services/kubectl/tools/kubectl_logs/KubectlLogsTool.js';
import { KubectlRestartDeploymentTool } from '../services/kubectl/tools/kubectl_restart_deployment/KubectlRestartDeploymentTool.js';
import { KubectlRolloutStatusTool } from '../services/kubectl/tools/kubectl_rollout_status/KubectlRolloutStatusTool.js';
import { KubectlScaleDeploymentTool } from '../services/kubectl/tools/kubectl_scale_deployment/KubectlScaleDeploymentTool.js';
import { KubectlTopPodsTool } from '../services/kubectl/tools/kubectl_top_pods/KubectlTopPodsTool.js';
// logs-query
import { LogsQueryTool } from '../services/logs-query/tools/logs_query/LogsQueryTool.js';
// metrics-query
import { MetricsQueryTool } from '../services/metrics-query/tools/metrics_query/MetricsQueryTool.js';
// optimizely
import { OptimizelyGetFlagsTool } from '../services/optimizely/tools/optimizely_get_flags/OptimizelyGetFlagsTool.js';
import { OptimizelyUpdateFlagTool } from '../services/optimizely/tools/optimizely_update_flag/OptimizelyUpdateFlagTool.js';
// tools-documentation
import { ToolsDocumentationTool } from '../services/tools-documentation/tools/tools_documentation/ToolsDocumentationTool.js';
import { ToolSearchTool } from '../services/tools-documentation/tools/tool_search/ToolSearchTool.js';
// traces-query
import { TracesQueryTool } from '../services/traces-query/tools/traces_query/TracesQueryTool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolConstructor = new (service: any) => BaseTool;

/** Map from service name → tool constructor list */
const SERVICE_TOOLS: Record<string, ToolConstructor[]> = {
  'alerts':                  [FredoUiAlertTool],
  'fredo-ui':                [FredoUiCollectResponsesTool, FredoUiStepperTool],
  'azdo-workitems':          [AzdoCreateWorkitemTool, AzdoStartWorkitemTool],
  'code-execution':          [CodeExecuteTool],
  'infrastructure-diagram':  [InfrastructureSnapshotTool, InfrastructureStreamTool],
  'jira':                    [JiraCreateIssueTool, JiraGetIssueDetailsTool, JiraGetMyIssuesTool],
  'kubectl':                 [
    KubectlDeletePodTool, KubectlDescribePodTool, KubectlExecTool,
    KubectlGetDeploymentsTool, KubectlGetEventsTool, KubectlGetPodsTool,
    KubectlGetServicesTool, KubectlLogsTool, KubectlRestartDeploymentTool,
    KubectlRolloutStatusTool, KubectlScaleDeploymentTool, KubectlTopPodsTool,
  ],
  'logs-query':              [LogsQueryTool],
  'metrics-query':           [MetricsQueryTool],
  'optimizely':              [OptimizelyGetFlagsTool, OptimizelyUpdateFlagTool],
  'tools-documentation':     [ToolsDocumentationTool, ToolSearchTool],
  'traces-query':            [TracesQueryTool],
};

type ServiceConstructor = new () => BaseService;

const ALL_SERVICES: ServiceConstructor[] = [
  AlertsService,
  FredoUiService,
  AzdoWorkitemsService,
  CodeExecutionService,
  DevModeService,
  InfrastructureDiagramService,
  JiraService,
  KubectlService,
  LogIngestionService,
  LogsQueryService,
  MetricsQueryService,
  OptimizelyService,
  ToolsDocumentationService,
  TracesQueryService,
];

export class EmbeddedServiceLoader {
  private services: Map<string, BaseService> = new Map();
  private tools: Map<string, BaseTool> = new Map();
  private toolToServiceMap: Map<string, string> = new Map();
  private serviceTools: Map<string, BaseTool[]> = new Map();
  private toolMetadata: Map<string, { serviceName: string; folderPath: string }> = new Map();

  async loadServices(): Promise<void> {
    // 1. Instantiate and init all services
    for (const ServiceClass of ALL_SERVICES) {
      try {
        const service = new ServiceClass() as BaseService;
        await service.init();
        this.services.set(service.name, service);
        console.log(`[EmbeddedLoader] ✅ Loaded service: ${service.name}`);
      } catch (err) {
        console.error(`[EmbeddedLoader] ❌ Failed to load ${ServiceClass.name}:`, err);
      }
    }

    // 2. Register tools per service
    for (const [serviceName, toolCtors] of Object.entries(SERVICE_TOOLS)) {
      const service = this.services.get(serviceName);
      if (!service) {
        console.warn(`[EmbeddedLoader] Service '${serviceName}' not loaded, skipping its tools`);
        continue;
      }

      const loaded: BaseTool[] = [];
      for (const ToolCtor of toolCtors) {
        try {
          const tool = new ToolCtor(service) as BaseTool;
          this.tools.set(tool.name, tool);
          this.toolToServiceMap.set(tool.name, serviceName);
          this.toolMetadata.set(tool.name, { serviceName, folderPath: serviceName });
          loaded.push(tool);
        } catch (err) {
          console.error(`[EmbeddedLoader] ❌ Failed to load tool ${ToolCtor.name}:`, err);
        }
      }
      this.serviceTools.set(serviceName, loaded);
    }

    // 3. Inject tools into tools-documentation service
    const toolsDocService = this.services.get('tools-documentation');
    if (toolsDocService) {
      if (typeof (toolsDocService as any).setTools === 'function') {
        (toolsDocService as any).setTools(this.getTools());
      }
      if (typeof (toolsDocService as any).setToolMetadata === 'function') {
        (toolsDocService as any).setToolMetadata(this.toolMetadata);
      }
      if (typeof (toolsDocService as any).setServiceLoader === 'function') {
        (toolsDocService as any).setServiceLoader(this);
      }
    }

    console.log(`[EmbeddedLoader] Loaded ${this.services.size} services, ${this.tools.size} tools`);
  }

  // ------------------------------------------------------------------ //
  // Public API (matches ServiceLoader)
  // ------------------------------------------------------------------ //

  getServices(): BaseService[] {
    return Array.from(this.services.values());
  }

  getService(name: string): BaseService | undefined {
    return this.services.get(name);
  }

  getTools(): BaseTool[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  getToolServiceName(toolName: string): string | undefined {
    return this.toolToServiceMap.get(toolName);
  }

  getServiceTools(serviceName: string): BaseTool[] {
    return this.serviceTools.get(serviceName) ?? [];
  }

  /** Alias used by Router — matches ServiceLoader.getToolsForService() */
  getToolsForService(serviceName: string): BaseTool[] {
    return this.getServiceTools(serviceName);
  }
}
