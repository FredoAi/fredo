pub mod fredo_ui;
pub mod azdo;
pub mod code_execute;
pub mod infrastructure;
pub mod jira;
pub mod k8s;
pub mod kubectl;
pub mod observability;
pub mod optimizely;
pub mod runner;
pub mod server;
pub mod tools_doc;

use crate::runtime::capability::{CliCapable, McpCapable};

/// Feature that exposes all fredo MCP tools via stdio or SSE/HTTP transport.
/// Launch with: `fredo mcp` (stdio) or `fredo mcp --sse --port 3001` (HTTP).
pub struct McpFeature;

impl CliCapable for McpFeature {}
impl McpCapable for McpFeature {}
