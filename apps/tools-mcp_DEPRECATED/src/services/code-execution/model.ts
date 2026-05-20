export interface CodeExecuteRequest {
  code: string;
  language: 'python' | 'javascript' | 'typescript' | 'go' | 'java' | 'r';
  libraries?: string[];
  timeout_ms?: number;
  enable_tools?: boolean;
  /** Forwarded from the MCP session so sandbox tool calls share the same event stream */
  sessionId?: string;
}

export interface CodeExecuteResponse {
  success: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  execution_time_ms: number;
  language: string;
}
