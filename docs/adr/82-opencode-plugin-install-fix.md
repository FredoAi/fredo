# ADR-82: OpenCode Plugin Install Fix

## Status
Proposed

## Context
The Setup Wizard's "Install Plugin" step copies raw TypeScript source files from `apps/opencode-plugin/` to `~/.config/opencode/plugins/fredo/`, but OpenCode's plugin system requires compiled JavaScript (`dist/index.js`, per `package.json`'s `"main"` field). The current implementation has four bugs:

1. **No build step**: `dist/index.js` is never produced — `bun build` is never called before copying.
2. **No config registration**: The plugin is never added to opencode's `opencode.json` under the `"plugin"` array, so OpenCode never loads it.
3. **Weak detection**: `is_opencode_plugin_installed` checks only for `plugin.json` existence, which is trivially satisfied after file copy — the UI shows ✅ but the plugin is dead code.
4. **Incomplete production bundle**: `tauri.conf.json` resources only include `plugin.json`; in production, `dist/index.js` and `package.json` are unavailable.

The plugin uses `@opencode-ai/plugin` SDK (v1.15.5) and is built with `bun build src/index.ts --outdir dist --target bun`. The `"main"` field in `package.json` points to `dist/index.js`.

## Decision
1. **Auto-build in `install_plugin`**: The Rust `install_plugin` command will attempt to build the plugin before copying files. It will shell out to `bun build src/index.ts --outdir dist --target bun` in the plugin source directory. If `dist/index.js` already exists (pre-built), the build step is skipped. If bun is not installed, the command returns a clear error with installation instructions.

2. **Config registration**: After copying files, `install_plugin` will read `~/.config/opencode/opencode.json`, parse it as JSON, add `"fredo"` to the `"plugin"` array (creating the array if absent, or the file if it doesn't exist with `"$schema"` included), and write it back. This is idempotent — re-running won't duplicate the entry.

3. **Strengthened detection**: `is_opencode_plugin_installed` will check for both `dist/index.js` existence AND `"fredo"` presence in the opencode config's `plugin` array. The check returns `true` only when both conditions are met.

4. **Production resource bundle**: `tauri.conf.json` will include `dist/index.js` and `package.json` as additional resources alongside `plugin.json`. The `install_plugin` command's fallback path (workspace relative to `CARGO_MANIFEST_DIR`) remains for dev mode. In production, the resource directory provides all three files.

5. **Build step in setup plan**: `get_setup_plan` will include a `plugin-build` step before `plugin-install`. The build step shows status: "skipped" if `dist/index.js` already exists, "needed" if not, "blocked" if bun is not installed.

## Consequences
### Positive
- Plugin actually works after installation — OpenCode can load and execute the hooks
- Detection accurately reflects whether the plugin is functional
- Production builds include all necessary plugin files
- Idempotent — can be re-run safely
- Auto-build fallback means pre-built artifacts aren't required in dev mode

### Negative
- Adds `bun` as an implicit dev dependency for the plugin build step (runtime `bun` not required — only for build)
- Tauri command blocks briefly while building (typically <1s for this small plugin)
- Production bundle size increases marginally (~3KB for `dist/index.js` + `package.json`)

### Risks
- If `bun` is not installed and `dist/index.js` doesn't exist in production, the install step fails — mitigated by including `dist/index.js` in the production bundle so it's always pre-built
- Opencode config file format could change — mitigated by reading/writing as structured JSON with fallback for missing file
- Windows path handling edge cases in Rust build command — mitigated by using `Command::new("bun")` with `.current_dir()` instead of shell execution