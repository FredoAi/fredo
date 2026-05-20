/**
 * fredo-plugin.ts — OpenCode plugin entry point for Fredo.
 *
 * Installs to ~/.config/opencode/plugins/fredo/ and hooks into OpenCode's
 * event system to forward telemetry to the Fredo desktop app via the `fredo` CLI.
 *
 * Compatible with OpenCode's plugin conventions:
 *   - JS/TS file in ~/.config/opencode/plugins/
 *   - Referenced via "plugin": [] in ~/.config/opencode/opencode.json
 */

/**
 * MCP server configuration for Fredo.
 * OpenCode reads this to register the Fredo MCP server.
 */
export const mcpServers = {
  fredo: {
    type: 'stdio' as const,
    command: 'fredo',
    args: ['mcp'],
    description:
      'Fredo MCP server — 27 tools for Kubernetes, Jira, Azure DevOps, Optimizely, observability, code execution, and Fredo UI.',
  },
};

/**
 * Hook handlers for OpenCode lifecycle events.
 * Forwards telemetry to Fredo via the `fredo` CLI dispatch mechanism.
 */
export function onEvent(event: { type: string; payload?: Record<string, unknown> }) {
  // OpenCode emits events that Fredo's OTLP receivers pick up automatically.
  // This hook provides an additional path for plugin-level events.
  if (typeof window !== 'undefined' && (window as any).__fredo_bridge) {
    (window as any).__fredo_bridge.emit(event);
  }
}

/**
 * Plugin metadata.
 */
export const metadata = {
  name: 'fredo',
  version: '2.0.0',
  description: 'Fredo mission control plugin for OpenCode',
};
