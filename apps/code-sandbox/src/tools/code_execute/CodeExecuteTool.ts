/**
 * CodeExecuteTool — executes user code in an isolated sandbox container.
 *
 * Architecture:
 *  - Channel 1 (control plane): HTTP POST to Python sandbox service at
 *    http://localhost:${SANDBOX_SERVICE_PORT}/execute
 *  - Channel 2 (tool bridge): Unix socket /var/run/fredo/tools.sock mounted
 *    into the execution container. Code inside the container calls tools by
 *    sending newline-delimited JSON over the socket.
 *
 * The preamble injected before user code contains language-specific helper
 * functions/classes that connect to the Unix socket so users can call
 * tools like `call_tool("logs_query", {"query": "..."})`.
 */

export interface CodeExecuteInput {
  code: string;
  language: 'python' | 'javascript' | 'typescript' | 'go' | 'java' | 'r';
  libraries?: string[];
  timeout_ms?: number;
  /** Whether to inject tool stubs into the preamble (default: true) */
  enable_tools?: boolean;
}

export interface CodeExecuteResult {
  success: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  execution_time_ms: number;
  language: string;
}

// Tools that have allowProgrammaticCalling=true — stubs are generated for these
const PROGRAMMATIC_TOOLS = (
  process.env.PROGRAMMATIC_TOOLS ??
  'kubectl_get_pods,kubectl_describe_pod,kubectl_logs,kubectl_get_events,kubectl_get_deployments,kubectl_get_services,kubectl_scale_deployment,kubectl_restart_deployment,kubectl_rollout_status,kubectl_top_pods,kubectl_exec,kubectl_delete_pod,logs_query,metrics_query,traces_query,infrastructure_snapshot,infrastructure_stream,jira_get_my_issues,jira_get_issue_details,jira_create_issue,azdo_create_workitem,azdo_start_workitem'
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const SANDBOX_SERVICE_URL = `http://localhost:${process.env.SANDBOX_SERVICE_PORT ?? '8080'}`;
const SOCKET_HOST_PATH =
  process.env.TOOL_BRIDGE_SOCKET ?? '/var/run/fredo/tools.sock';

// ---------------------------------------------------------------------------
// Preamble generation
// ---------------------------------------------------------------------------

function generatePreamble(language: string, tools: string[]): string {
  if (tools.length === 0) return '';

  switch (language.toLowerCase()) {
    case 'python':
      return generatePythonPreamble(tools);
    case 'javascript':
    case 'typescript':
      return generateJsPreamble(tools);
    case 'go':
      return generateGoPreamble(tools);
    default:
      return '';
  }
}

function generatePythonPreamble(tools: string[]): string {
  const toolList = tools.map((t) => `"${t}"`).join(', ');
  return `
# ============================================================
# Fredo Tool Bridge — auto-generated preamble
# Available tools: ${toolList}
# ============================================================
import socket, json as _json, os as _os

def call_tool(tool_name: str, input_data: dict) -> dict:
    """Call a Fredo MCP tool via the Unix socket bridge."""
    sock_path = "/var/run/fredo/tools.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as _s:
        _s.connect(sock_path)
        payload = _json.dumps({"tool": tool_name, "input": input_data}) + "\\n"
        _s.sendall(payload.encode())
        # Read until newline
        _buf = b""
        while True:
            _chunk = _s.recv(4096)
            if not _chunk:
                break
            _buf += _chunk
            if b"\\n" in _buf:
                break
        return _json.loads(_buf.split(b"\\n")[0])

# Convenience wrappers for each allowed tool
${tools.map((t) => `def ${t}(**kwargs): return call_tool("${t}", kwargs)`).join('\n')}

# ============================================================
# End of preamble — user code below
# ============================================================
`;
}

function generateJsPreamble(tools: string[]): string {
  const toolList = tools.map((t) => `"${t}"`).join(', ');
  return `
// ============================================================
// Fredo Tool Bridge — auto-generated preamble
// Available tools: ${toolList}
// ============================================================
const net = require('net');
function callTool(toolName, inputData) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection('/var/run/fredo/tools.sock', () => {
      client.write(JSON.stringify({ tool: toolName, input: inputData }) + '\\n');
    });
    let buf = '';
    client.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\\n')) {
        client.destroy();
        try { resolve(JSON.parse(buf.split('\\n')[0])); } catch(e) { reject(e); }
      }
    });
    client.on('error', reject);
  });
}

// Convenience wrappers
${tools.map((t) => `const ${t.replace(/_([a-z])/g, (_, c) => c.toUpperCase())} = (args) => callTool("${t}", args);`).join('\n')}

// ============================================================
`;
}

function generateGoPreamble(_tools: string[]): string {
  return `
// ============================================================
// Fredo Tool Bridge — auto-generated preamble
// ============================================================
package main
import (
  "encoding/json"
  "fmt"
  "net"
  "os"
)
func callTool(toolName string, input map[string]interface{}) (map[string]interface{}, error) {
  conn, err := net.Dial("unix", "/var/run/fredo/tools.sock")
  if err != nil { return nil, err }
  defer conn.Close()
  payload, _ := json.Marshal(map[string]interface{}{"tool": toolName, "input": input})
  conn.Write(append(payload, '\\n'))
  buf := make([]byte, 65536)
  n, err := conn.Read(buf)
  if err != nil { return nil, err }
  var result map[string]interface{}
  json.Unmarshal(buf[:n], &result)
  return result, nil
}
var _ = fmt.Println // suppress unused import
var _ = os.Stdout   // suppress unused import
// ============================================================
`;
}

// ---------------------------------------------------------------------------
// CodeExecuteTool
// ---------------------------------------------------------------------------

export class CodeExecuteTool {
  readonly name = 'code_execute';
  readonly description =
    'Execute code in an isolated sandbox. ' +
    'Supported languages: python, javascript, typescript, go, java, r. ' +
    'Code runs with network disabled. Tool stubs are injected automatically so ' +
    'you can call Fredo tools (logs_query, kubectl_*, jira_*, etc.) from inside ' +
    'the code via the `call_tool()` helper (Python) or `callTool()` (JS). ' +
    'DO NOT use for simple text processing — only for real computation, data ' +
    'aggregation, or multi-step analysis that benefits from code execution.';

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string',
        description: 'The code to execute. Tool stubs are automatically prepended.',
      },
      language: {
        type: 'string',
        enum: ['python', 'javascript', 'typescript', 'go', 'java', 'r'],
        description: 'Programming language to use',
      },
      libraries: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of library names to install before execution ' +
          '(e.g. ["pandas", "numpy"]). Pip for Python, npm for JS.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Execution timeout in milliseconds (default 30000, max 120000)',
        default: 30000,
        minimum: 1000,
        maximum: 120000,
      },
      enable_tools: {
        type: 'boolean',
        description:
          'Whether to inject tool stubs into the preamble (default: true). ' +
          'Set to false if you want clean execution without the bridge overhead.',
        default: true,
      },
    },
    required: ['code', 'language'],
    additionalProperties: false,
  };

  readonly inputExamples = [
    {
      title: 'Simple Python computation',
      description: 'Run Python to compute something',
      input: { code: 'print(sum(range(100)))', language: 'python' },
    },
    {
      title: 'Query logs and compute statistics',
      description: 'Fetch error logs via tool bridge and compute hourly counts',
      input: {
        language: 'python',
        code: `
result = logs_query(
    query="SELECT DATE_TRUNC('hour', timestamp) as hour, COUNT(*) as cnt FROM application_logs WHERE level='ERROR' AND timestamp >= NOW() - INTERVAL '24 hours' GROUP BY hour ORDER BY hour"
)
import json
rows = json.loads(json.dumps(result)).get('rows', [])
for row in rows:
    print(f"{row['hour']}: {row['cnt']} errors")
`,
      },
    },
    {
      title: 'JavaScript with npm library',
      description: 'Run JS code with an extra library',
      input: {
        code: "const _ = require('lodash'); console.log(_.sum([1,2,3,4,5]));",
        language: 'javascript',
        libraries: ['lodash'],
        timeout_ms: 15000,
      },
    },
  ];

  async execute(input: Record<string, unknown>): Promise<CodeExecuteResult> {
    const {
      code,
      language = 'python',
      libraries = [],
      timeout_ms = 30000,
      enable_tools = true,
    } = input as unknown as CodeExecuteInput;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      throw new Error('code is required and must be a non-empty string');
    }

    const lang = String(language);
    const timeoutMs = Math.min(Math.max(1000, Number(timeout_ms)), 120_000);
    const withTools = Boolean(enable_tools);

    // Build preamble + user code
    const preamble = withTools ? generatePreamble(lang, PROGRAMMATIC_TOOLS) : '';
    const fullCode = preamble + '\n' + code;

    // Call the Python sandbox service
    const response = await fetch(`${SANDBOX_SERVICE_URL}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: fullCode,
        language: lang,
        libraries: Array.isArray(libraries) ? libraries : [],
        timeout_ms: timeoutMs,
        network: 'none',
        socket_host_path: withTools ? SOCKET_HOST_PATH : null,
      }),
      signal: AbortSignal.timeout(timeoutMs + 10_000), // extra buffer for startup
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Sandbox service error ${response.status}: ${text}`);
    }

    const result = (await response.json()) as CodeExecuteResult;
    return { ...result, language: lang };
  }
}
