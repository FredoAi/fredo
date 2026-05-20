import { BaseTool, ToolInputSchema, ToolExample } from '../../../../core/BaseTool.js';
import type { CodeExecutionService } from '../../service.js';

export class CodeExecuteTool extends BaseTool {
  readonly name = 'code_execute';
  readonly description =
    'Execute code in an isolated sandbox container. ' +
    'Supported languages: python, javascript, typescript, go, java, r. ' +
    'Tool stubs for Atlas tools (kubectl_*, logs_query, jira_*, etc.) are ' +
    'automatically injected so code can call them via plain function calls — no imports needed. ' +
    'CRITICAL: When you need to call multiple tools (e.g. get pods AND query logs AND describe pods), ' +
    'put ALL of them in a SINGLE script. Never call code_execute more than once in a row — ' +
    'write one script that calls every tool you need, processes the combined results, and prints the final output. ' +
    'Use for computation, data aggregation, parallel tool calls, or any sequence of tool calls ' +
    'where intermediate results do not need to be reasoned about before the next step.';

  readonly exposedAs = 'mcp' as const;
  readonly deferLoading = false;
  readonly allowProgrammaticCalling = false;

  private service: CodeExecutionService;

  constructor(service: CodeExecutionService) {
    super();
    this.service = service;
  }

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The code to execute. Tool stubs are automatically prepended.',
      },
      language: {
        type: 'string',
        enum: ['python', 'javascript', 'typescript', 'go', 'java', 'r'],
        description: 'Programming language',
      },
      libraries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Packages to install before execution (pip for Python, npm for JS)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Execution timeout in milliseconds (default 30000, max 120000)',
        default: 30000,
      },
      enable_tools: {
        type: 'boolean',
        description: 'Inject Atlas tool stubs into preamble (default: true)',
        default: true,
      },
    },
    required: ['code', 'language'],
    additionalProperties: false,
  };

  readonly inputExamples: ToolExample[] = [
    {
      title: 'Multiple tools in one script (preferred pattern)',
      description: 'Call kubectl, logs, and metrics all in a single script — never use separate code_execute calls',
      input: {
        language: 'python',
        code: `import json

# Step 1: get pods
pods_result = kubectl_get_pods(allNamespaces=True)
pods = pods_result.get('pods') or []
crashing = [p for p in pods if p.get('restartCount', 0) > 3]

# Step 2: query recent errors for crashing services
services = list({p['name'].rsplit('-', 2)[0] for p in crashing})
logs_result = logs_query(query="SELECT service_name, COUNT(*) as errors FROM application_logs WHERE level='ERROR' AND timestamp >= (SELECT MAX(timestamp) FROM application_logs) - INTERVAL '1 hour' GROUP BY service_name ORDER BY errors DESC LIMIT 20")
error_rows = logs_result.get('rows') or []

# Step 3: query latest metrics
metrics_result = metrics_query(query="SELECT name, value FROM metrics WHERE timestamp >= (SELECT MAX(timestamp) FROM metrics) - INTERVAL '1 hour' ORDER BY timestamp DESC LIMIT 5")
metric_rows = metrics_result.get('rows') or []

print(f"Crashing pods: {len(crashing)}")
for row in error_rows:
    print(f"  {row['service_name']}: {row['errors']} errors")
for row in metric_rows:
    print(f"  metric {row['name']}: {row['value']}")
`,
      },
    },
    {
      title: 'Aggregate pod restarts across namespaces',
      description: 'Count total restarts per namespace using kubectl',
      input: {
        language: 'python',
        code: `import json
from collections import defaultdict
result = kubectl_get_pods(allNamespaces=True)
restarts = defaultdict(int)
for pod in (result.get('pods') or []):
    restarts[pod['namespace']] += pod.get('restartCount', 0)
for ns, count in sorted(restarts.items(), key=lambda x: -x[1]):
    print(f"{ns}: {count} restarts")`,
      },
    },
    {
      title: 'Quick Python computation',
      description: 'Simple calculation without tool stubs',
      input: {
        language: 'python',
        code: 'print(sum(i**2 for i in range(100)))',
        enable_tools: false,
      },
    },
  ];

  async execute(input: Record<string, unknown>, context?: any): Promise<unknown> {
    const req = { ...input, sessionId: context?.sseConnectionId } as any;
    return this.service.controller.execute(req);
  }
}
