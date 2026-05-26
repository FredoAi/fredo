# Contract: OpenCode Plugin Install Fix

## Public Interface

### Tauri Commands (`features/setup/commands.rs`)

#### `install_plugin(app: AppHandle) -> InstallResult`
- **Precondition**: Plugin source directory exists (either `resource_dir/plugin/` for production or `CARGO_MANIFEST_DIR/../../../apps/opencode-plugin/` for dev)
- **Behavior**:
  1. Resolve home directory and source directory
  2. If `dist/index.js` does not exist in source directory, attempt to build by running `bun build src/index.ts --outdir dist --target bun` in the source directory
  3. If build fails or bun is not found, return `InstallResult { success: false, error: Some(...) }`
  4. Create destination directory `~/.config/opencode/plugins/fredo/`
  5. Copy all files from source directory (including `dist/` subdirectory) to destination
  6. Register `"fredo"` in opencode config (`~/.config/opencode/opencode.json`)
  7. Configure OTEL environment variables (existing behavior, unchanged)
- **Return**: `InstallResult { success: bool, output: String, error: Option<String> }`

#### `check_cli_installations(app: AppHandle) -> CliCheckResult`
- **Change**: `opencode_plugin_installed` field now returns `true` only when both conditions are met: `dist/index.js` exists in plugin dir AND `"fredo"` is in opencode config's `plugin` array
- **Return**: `CliCheckResult { opencode: bool, opencode_plugin_installed: bool }`

#### `get_setup_plan(app: AppHandle) -> SetupPlan`
- **New step**: `plugin-build` step (id: `"plugin-build"`) inserted before `plugin-install`
  - Status: `"skipped"` if `dist/index.js` exists in source dir, `"needed"` if not, `"blocked"` if `bun` is not available
  - Command: `cd <plugin_src> && bun build src/index.ts --outdir dist --target bun`
- **Modified step**: `plugin-install` status now depends on strengthened detection (both `dist/index.js` + config registration)

#### `is_opencode_plugin_installed(home: &PathBuf) -> bool`
- **Changed**: Returns `true` only when ALL of:
  1. `~/.config/opencode/plugins/fredo/plugin.json` exists
  2. `~/.config/opencode/plugins/fredo/dist/index.js` exists
  3. `~/.config/opencode/opencode.json` contains `"fredo"` in the `plugin` array

#### `get_plugin_source_path(app: AppHandle) -> Result<String, String>`
- **Unchanged**: Returns the plugin source directory path

### Helper: `register_plugin_in_opencode_config(home: &PathBuf) -> Result<(), String>` (NEW)
- Creates `~/.config/opencode/opencode.json` if it doesn't exist (with `"$schema"` and `"plugin": ["fredo"]`)
- If file exists, parses as JSON, adds `"fredo"` to the `plugin` array if not already present, writes back
- Idempotent — re-running does not duplicate `"fredo"`

### Helper: `build_opencode_plugin(src_dir: &PathBuf) -> Result<(), String>` (NEW)
- Checks if `src_dir/dist/index.js` already exists; if so, returns `Ok(())` (skip build)
- Runs `bun build src/index.ts --outdir dist --target bun` with `.current_dir(src_dir)`
- If `bun` is not found or build fails, returns `Err` with descriptive message

## Events Emitted
- No new Tauri events emitted. The setup wizard's existing event flow is unchanged.
- OTEL configuration events remain unchanged (`configure_opencode_otel`).

## State Managed
- **File system state**:
  - `~/.config/opencode/plugins/fredo/` — plugin files (including new `dist/index.js`, `package.json`)
  - `~/.config/opencode/opencode.json` — plugin registration (new `"fredo"` entry)
  - `apps/opencode-plugin/dist/index.js` — built plugin output (created by build step)
- **Environment variables**: No changes to OTEL var handling (`OPENCODE_ENABLE_TELEMETRY`, `OPENCODE_OTLP_ENDPOINT`, `OPENCODE_OTLP_PROTOCOL`)

## Dependencies
- `bun` CLI — required at build time if `dist/index.js` is not pre-built
- `@opencode-ai/plugin` SDK (v1.15.5) — existing, unchanged
- `tauri_plugin_mcp_bridge` — existing, unchanged
- OpenCode config file format (`opencode.json` with `$schema` and `plugin` array) — assumed stable

## Forbidden Changes
- Do not change the OpenCode plugin's source code in `apps/opencode-plugin/src/index.ts` — this spec only fixes the installation flow
- Do not change the `@opencode-ai/plugin` SDK version
- Do not remove or change the OTEL configuration (`configure_opencode_otel`) — it must continue to work
- Do not change the `FredoEvent` or `OpenCodeAdapter` types
- Do not add new Tauri events or commands beyond the setup feature scope
- Do not modify the `is_binary_available` helper signature