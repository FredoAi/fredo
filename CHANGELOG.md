# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Replaced all Claude Code and GitHub Copilot CLI references with **OpenCode** as the sole AI CLI provider across Rust backend, React UI, marketplace plugin, workspace config, and documentation. ([#5](https://github.com/pktron/fredo/issues/5))
  - Setup Wizard simplified to single OpenCode detection and setup flow (no more provider selection)
  - Run CLI hardcodes `opencode` binary (no more provider toggle)
  - OTLP receivers (gRPC :4317, HTTP :4318) now documented as OpenCode endpoints
  - Mission Monitor attribute mapping updated from `github.copilot.*` to `gen_ai.*`
  - New `fredo-plugin.ts` for OpenCode plugin system replaces old Copilot/Claude hooks
  - Environment variables changed: `OPENCODE_ENABLE_TELEMETRY`, `OPENCODE_OTLP_ENDPOINT`, `OPENCODE_OTLP_PROTOCOL`
  - Plugin installation targets `~/.config/opencode/plugins/fredo/`

### Added
- Load custom `chat_template.jinja` from model directory for LLM engine. Custom templates take priority over the model's embedded template, with graceful fallback to hardcoded Gemma format. ([#1](https://github.com/pktron/fredo/issues/1))
