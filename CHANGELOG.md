# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Brand cleanup**: Renamed all remaining "Atlas" references to "Fredo" in active code (asset files, imports, package names, socket paths). ([#17](https://github.com/pktron/fredo/issues/17))
  - `atlas-*.png` assets renamed to `fredo-*.png`
  - `@atlas/code-sandbox` renamed to `@fredo/code-sandbox`
  - Socket paths changed from `/var/run/atlas/` to `/var/run/fredo/`
- **CLI simplification**: Removed `fredo hook` and `fredo mcp` subcommands. Added `fredo opencode-plugin <event-type> [--payload <json>]` as the single CLI interface for forwarding OpenCode plugin events to the running Tauri app. ([#17](https://github.com/pktron/fredo/issues/17))
  - `CliCommand::AgentHook` renamed to `CliCommand::OpenCodePlugin`
  - IPC dispatch now validates event types against an allowlist (SEC-REQ-2)
  - IPC messages enforce a 1MB max payload size (SEC-REQ-4)
  - Unix domain socket permissions restricted to owner-only (0o600) (SEC-REQ-1)
- **OpenCode plugin rewrite**: Replaced `apps/marketplace-plugin/` with `apps/opencode-plugin/` using the `@opencode-ai/plugin` SDK. The new plugin hooks into all available OpenCode events (`chat.message`, `tool.execute.before/after`, `permission.ask`, `command.execute.before`, `shell.env`, `event`) and forwards data to the Tauri app via `fredo opencode-plugin`. ([#17](https://github.com/pktron/fredo/issues/17))
  - MCP discovery removed from `plugin.json` (reduces attack surface)
  - Plugin uses `.args()` for safe CLI argument passing (SEC-REQ-3)
  - Setup Wizard and Tauri config updated for new plugin path
- Previously: Replaced all Claude Code and GitHub Copilot CLI references with **OpenCode** as the sole AI CLI provider. ([#5](https://github.com/pktron/fredo/issues/5))
  - Setup Wizard simplified to single OpenCode detection and setup flow (no more provider selection)
  - Run CLI hardcodes `opencode` binary (no more provider toggle)
  - OTLP receivers (gRPC :4317, HTTP :4318) now documented as OpenCode endpoints
  - Mission Monitor attribute mapping updated from `github.copilot.*` to `gen_ai.*`
  - Environment variables changed: `OPENCODE_ENABLE_TELEMETRY`, `OPENCODE_OTLP_ENDPOINT`, `OPENCODE_OTLP_PROTOCOL`
  - Plugin installation targets `~/.config/opencode/plugins/fredo/`

### Added
- Load custom `chat_template.jinja` from model directory for LLM engine. Custom templates take priority over the model's embedded template, with graceful fallback to hardcoded Gemma format. ([#1](https://github.com/pktron/fredo/issues/1))

### Removed
- `fredo hook` CLI subcommand (replaced by `fredo opencode-plugin`)
- `fredo mcp` CLI subcommand (MCP server remains internal to Tauri process)
- `CliCommand::AgentHook` IPC variant (replaced by `CliCommand::OpenCodePlugin`)
- `McpCapable` trait (unused stub)
- `apps/marketplace-plugin/` directory (replaced by `apps/opencode-plugin/`)
