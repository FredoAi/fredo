/**
 * Capability interfaces — TypeScript mirror of `src-tauri/src/runtime/capability.rs`.
 *
 * These interfaces declare what transport surfaces a feature may expose.
 * `FredoFeatureClass` is the concrete implementation of `DesktopCapable` for
 * all grid features — implementing this interface is implicit via the class contract.
 *
 * Adding a new transport (e.g. MCP) means implementing `McpCapable` on the feature
 * and wiring it through the relevant adapter.
 */

/**
 * A feature that renders in the desktop UI.
 * Implemented concretely by `FredoFeatureClass`.
 */
export interface DesktopCapable {
  readonly id: string;
  render(props?: unknown): React.ReactElement;
}

/**
 * Reserved — future MCP frontend integration.
 *
 * Features that implement this interface may declare MCP tool schemas,
 * expose prompts, and surface resources through a future MCP client adapter.
 * No features implement this yet; it exists to make the capability contract explicit.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface McpCapable {
  // mcpTools?(): McpToolSchema[];   // future
  // mcpPrompts?(): McpPromptSchema[]; // future
}
