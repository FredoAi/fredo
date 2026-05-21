import { BaseTool, ToolInputSchema, ToolExample } from '../../../../core/BaseTool.js';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Tool for retrieving documentation for other tools
 * Each tool stores its documentation in a doc.md file within its folder
 */
export class ToolsDocumentationTool extends BaseTool {
  readonly name = 'tools_documentation';
  readonly description = 'Use when you need detailed API specs, HTTP endpoints, or extended examples for a specific tool. Requires: toolName (string). Does NOT: execute tools, provide conceptual explanations. Returns: URL, HTTP method, full markdown documentation from tool\'s doc.md. Use sparingly - most tool info is in description. Call only when: debugging tool calls, need HTTP endpoint details, require extended examples.';

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      tool_name: {
        oneOf: [
          {
            type: 'string',
            description: 'Single tool name (e.g., "logs_query")'
          },
          {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of tool names for batch retrieval (e.g., ["logs_query", "metrics_query"])'
          }
        ],
        description: 'The name(s) of the tool(s) to retrieve documentation for',
        example: 'logs_query'
      }
    },
    required: ['tool_name'],
    additionalProperties: false
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Get single tool documentation',
      description: 'Retrieve complete documentation for a single tool',
      input: {
        tool_name: 'logs_query'
      },
      output: {
        description: 'Returns documentation with URL, method, and full markdown content',
        example: {
          tool_name: 'logs_query',
          url: '/api/logs-query/query',
          method: 'POST',
          documentation: '# Logs Query Tool\n\n## Description\nExecutes SELECT queries...'
        }
      }
    },
    {
      title: 'Get multiple tools documentation',
      description: 'Retrieve documentation for multiple tools in one call',
      input: {
        tool_name: ['logs_query', 'metrics_query', 'traces_query']
      },
      output: {
        description: 'Returns array of documentation results',
        example: {
          results: [
            { tool_name: 'logs_query', url: '/api/logs-query/query', method: 'POST', documentation: '# Logs...' },
            { tool_name: 'metrics_query', url: '/api/metrics-query/query', method: 'POST', documentation: '# Metrics...' },
            { tool_name: 'traces_query', url: '/api/traces-query/query', method: 'POST', documentation: '# Traces...' }
          ]
        }
      }
    }
  ];

  readonly deferLoading = false; // Always visible — required for tool discovery workflow
  readonly allowProgrammaticCalling = false;

  readonly notes = [
    'Documentation files are stored as doc.md in each tool\'s folder',
    'All tools must have documentation to be discoverable',
    'Documentation includes table schemas, example queries, and usage guidelines',
    'Use this tool to understand how to construct proper queries for logs, metrics, and traces',
    'Supports batch retrieval: pass an array of tool names to get multiple documentations in one call',
    'Single tool returns object with tool_name, url, method, documentation. Multiple tools return { results: [...] }'
  ];

  readonly relatedTools = [
    'logs_query',
    'metrics_query',
    'traces_query'
  ];

  readonly exposedAs = 'mcp' as const;

  /**(
   * Execute tool with context-aware filtering based on transport type
   * @param input - Tool name(s) to retrieve documentation for
   * @param context - Execution context including transport type ('mcp' or 'api')
   */
  async execute(input: { tool_name: string | string[] }, context?: any): Promise<any> {
    let { tool_name } = input;
    const transport = context?.transport; // 'mcp', 'api', or undefined

    console.log('[ToolsDocumentationTool] Received tool_name:', tool_name, 'Type:', typeof tool_name, 'Transport:', transport);

    if (!tool_name) {
      throw new Error('tool_name is required');
    }

    // Parse JSON string if needed (MCP client might send array as JSON string)
    if (typeof tool_name === 'string' && tool_name.trim().startsWith('[')) {
      try {
        console.log('[ToolsDocumentationTool] Attempting to parse JSON string');
        tool_name = JSON.parse(tool_name);
        console.log('[ToolsDocumentationTool] Parsed to array:', tool_name);
      } catch (e) {
        console.log('[ToolsDocumentationTool] JSON parsing failed, treating as single tool');
        // If JSON parsing fails, treat as single tool name
      }
    }

    // Handle array of tool names
    if (Array.isArray(tool_name)) {
      console.log('[ToolsDocumentationTool] Processing array of', tool_name.length, 'tools');
      const results = await Promise.all(
        tool_name.map(async (name: string) => {
          try {
            return await this.getDocumentationForTool(name.trim(), transport);
          } catch (error) {
            return {
              tool_name: name,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        })
      );

      return { results };
    }

    // Handle single tool name
    if (typeof tool_name === 'string' && tool_name.trim().length === 0) {
      throw new Error('tool_name cannot be empty');
    }

    console.log('[ToolsDocumentationTool] Processing single tool:', tool_name);
    return await this.getDocumentationForTool(tool_name as string, transport);
  }

  /**
   * Get documentation for a single tool
   * @param toolName - Name of the tool
   * @param transport - Transport type for filtering ('mcp', 'api', or undefined)
   */
  private async getDocumentationForTool(toolName: string, transport?: string): Promise<any> {
    try {
      // Filter based on transport if specified
      if (transport) {
        const tool = this.getTool(toolName);
        if (tool) {
          const exposedAs = tool.exposedAs || 'both';
          
          // Skip if tool not exposed via this transport
          if (transport === 'mcp' && exposedAs === 'api') {
            throw new Error(`Tool ${toolName} is not available via MCP (API-only)`);
          }
          if (transport === 'api' && exposedAs === 'mcp') {
            throw new Error(`Tool ${toolName} is not available via API (MCP-only)`);
          }
        }
      }

      // Find the tool's documentation file
      const docPath = await this.findToolDocumentation(toolName);
      
      if (!docPath) {
        throw new Error(`Documentation not found for tool: ${toolName}. Available tools: logs_query, metrics_query, traces_query, tools_documentation`);
      }

      // Read the documentation file
      const documentation = await fs.readFile(docPath, 'utf-8');

      // Extract URL and method from documentation
      const { url, method } = this.parseDocumentationMetadata(documentation);

      return {
        tool_name: toolName,
        url: url || 'N/A',
        method: method || 'N/A',
        documentation
      };

    } catch (error: any) {
      throw new Error(`Failed to retrieve documentation for ${toolName}: ${error.message}`);
    }
  }

  /**
   * Get tool instance by name from service
   * Returns undefined if tool not found
   */
  private getTool(_toolName: string): any {
    // Access the service's tool registry via the serviceLoader
    // This requires the service to have access to all tools
    // For now, we'll need to add this capability
    return undefined; // Placeholder - will be enhanced in next step
  }

  /**
   * Find the documentation file for a tool
   * Searches through all service directories for the tool's doc.md
   */
  private async findToolDocumentation(toolName: string): Promise<string | null> {
    // Map tool names to their service directories
    const toolServiceMap: Record<string, string> = {
      'logs_query': 'logs-query',
      'metrics_query': 'metrics-query',
      'traces_query': 'traces-query',
      'tools_documentation': 'tools-documentation',
      'fredo_ui_stepper': 'fredo-ui',
      'fredo_ui_alert': 'alerts',
      'azdo_start_workitem': 'azdo-workitems',
      'azdo_create_workitem': 'azdo-workitems',
      'infrastructure_snapshot': 'infrastructure-diagram',
      'infrastructure_stream': 'infrastructure-diagram',
      // Kubectl tools
      'kubectl_get_pods': 'kubectl',
      'kubectl_get_deployments': 'kubectl',
      'kubectl_describe_pod': 'kubectl',
      'kubectl_logs': 'kubectl',
      'kubectl_get_services': 'kubectl',
      'kubectl_get_events': 'kubectl',
      'kubectl_top_pods': 'kubectl',
      'kubectl_rollout_status': 'kubectl',
      'kubectl_delete_pod': 'kubectl',
      'kubectl_scale_deployment': 'kubectl',
      'kubectl_restart_deployment': 'kubectl',
      'kubectl_exec': 'kubectl',
    };

    const serviceName = toolServiceMap[toolName];
    if (!serviceName) {
      return null;
    }

    // Construct path to doc.md in nested folder structure
    // From: /app/src/services/tools-documentation/tools/tools_documentation/
    // Go up 3 levels to services/, then into target service
    // Path: services/{service-name}/tools/{tool_name}/doc.md
    const servicesDir = join(__dirname, '../../../');
    const docPath = join(servicesDir, serviceName, 'tools', toolName, 'doc.md');

    try {
      await fs.access(docPath);
      return docPath;
    } catch {
      return null;
    }
  }

  /**
   * Parse URL and method from documentation markdown
   * Looks for ## URL and ## Method sections
   */
  private parseDocumentationMetadata(documentation: string): { url?: string; method?: string } {
    const result: { url?: string; method?: string } = {};

    // Extract URL
    const urlMatch = documentation.match(/##\s+URL\s*\n\s*```\s*\n\s*([^\n]+)/i) ||
                     documentation.match(/##\s+URL\s*\n\s*([^\n]+)/i);
    if (urlMatch) {
      result.url = urlMatch[1].trim();
    }

    // Extract Method
    const methodMatch = documentation.match(/##\s+Method\s*\n\s*```\s*\n\s*([^\n]+)/i) ||
                        documentation.match(/##\s+Method\s*\n\s*([^\n]+)/i);
    if (methodMatch) {
      result.method = methodMatch[1].trim();
    }

    return result;
  }
}

export default ToolsDocumentationTool;
