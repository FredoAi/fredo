import * as net from 'net';
import type { CodeExecuteRequest, CodeExecuteResponse } from './model.js';

const SANDBOX_SOCKET = process.env.CODE_SANDBOX_SOCKET ?? '/var/run/fredo/sandbox.sock';

// Tools that have allowProgrammaticCalling=true — stubs injected into sandbox preamble
const PROGRAMMATIC_TOOLS = (
  process.env.PROGRAMMATIC_TOOLS ??
  'kubectl_get_pods,kubectl_describe_pod,kubectl_logs,kubectl_get_events,kubectl_get_deployments,kubectl_get_services,kubectl_scale_deployment,kubectl_restart_deployment,kubectl_rollout_status,kubectl_top_pods,kubectl_exec,kubectl_delete_pod,logs_query,metrics_query,traces_query,infrastructure_snapshot,infrastructure_stream,jira_get_my_issues,jira_get_issue_details,jira_create_issue,azdo_create_workitem,azdo_start_workitem'
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const SOCKET_HOST_PATH = process.env.TOOL_BRIDGE_SOCKET ?? '/var/run/fredo/tools.sock';

// ---------------------------------------------------------------------------
// Preamble generation
// ---------------------------------------------------------------------------

function generatePreamble(language: string, tools: string[], sessionId?: string): string {
  if (tools.length === 0) return '';
  switch (language.toLowerCase()) {
    // Python: no preamble — sitecustomize.py handles stubs via env vars + tools.sock
    case 'python':      return '';
    case 'javascript':
    case 'typescript':  return generateJsPreamble(tools, sessionId);
    default:            return '';
  }
}

function generateJsPreamble(tools: string[], sessionId?: string): string {
  return `
// ============================================================
// Fredo Tool Bridge — auto-injected (Unix socket)
// ============================================================
const _Fredo_SESSION_ID = ${sessionId ? `'${sessionId}'` : 'null'};
function callTool(toolName, inputData) {
  return import('net').then(({ createConnection }) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(_Fredo_SESSION_ID ? { tool: toolName, input: inputData, sessionId: _Fredo_SESSION_ID } : { tool: toolName, input: inputData });
    let done = false;
    const client = createConnection('${SOCKET_HOST_PATH}', () => { client.write(payload + '\\n'); });
    let data = '';
    client.on('data', (d) => {
      data += d;
      const nl = data.indexOf('\\n');
      if (nl !== -1 && !done) {
        done = true;
        client.destroy();
        try { resolve(JSON.parse(data.slice(0, nl))); } catch(e) { reject(e); }
      }
    });
    client.on('error', (e) => { if (!done) { done = true; reject(e); } });
    client.on('end', () => { if (!done) { done = true; reject(new Error('Connection closed without response')); } });
  }));
}
${tools.map((t) => `const ${t.replace(/_([a-z])/g, (_, c) => c.toUpperCase())} = (args) => callTool("${t}", args);`).join('\n')}
// ============================================================
`;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class CodeExecutionRepository {
  async init(): Promise<void> {}

  async execute(req: CodeExecuteRequest): Promise<CodeExecuteResponse> {
    const {
      code,
      language,
      libraries = [],
      timeout_ms = 30_000,
      enable_tools = true,
    } = req;

    const timeoutMs = Math.min(Math.max(1_000, timeout_ms), 120_000);
    // Python: preamble is empty — sitecustomize.py + env vars injected by sandbox_service
    // JS/TS: inline preamble still needed (Node has no equivalent auto-import hook)
    const preamble = enable_tools ? generatePreamble(language, PROGRAMMATIC_TOOLS, req.sessionId) : '';
    const fullCode = preamble ? preamble + '\n' + code : code;

    const payload = JSON.stringify({
      code: fullCode,
      language,
      libraries,
      timeout_ms: timeoutMs,
      network: 'none',
      socket_host_path: enable_tools ? SOCKET_HOST_PATH : null,
      ...(enable_tools ? {
        session_id: req.sessionId ?? null,
        tools: PROGRAMMATIC_TOOLS.join(','),
      } : {}),
    });

    return new Promise<CodeExecuteResponse>((resolve, reject) => {
      const deadlineMs = timeoutMs + 15_000;
      const client = net.createConnection(SANDBOX_SOCKET, () => {
        client.write(payload + '\n');
      });

      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error(`Sandbox socket timed out after ${deadlineMs}ms`));
      }, deadlineMs);

      let buf = '';
      client.on('data', (chunk) => { buf += chunk.toString(); });
      client.on('end', () => {
        clearTimeout(timer);
        const line = buf.split('\n')[0].trim();
        try {
          resolve(JSON.parse(line || buf.trim()) as CodeExecuteResponse);
        } catch {
          reject(new Error(`Sandbox response parse error: ${buf.slice(0, 200)}`));
        }
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
