# Contract: Setup Wizard Refactor

## Public Interface

### New Tauri Command: `get_setup_plan`

```rust
#[tauri::command]
pub fn get_setup_plan(app: AppHandle) -> SetupPlan
```

**Returns:**
```rust
struct SetupPlan {
    steps: Vec<SetupPlanStep>,
    can_proceed: bool,          // false if opencode is missing
    opencode_docs_url: String,  // "https://opencode.ai/docs/install"
}

struct SetupPlanStep {
    id: String,                 // "fredo-path" | "opencode-cli" | "plugin-install"
    label: String,              // "Add Fredo CLI to user PATH"
    status: String,             // "skipped" | "needed" | "blocked"
    command: Option<String>,    // Exact shell command(s) shown in code block
    detail: Option<String>,     // Extra context (e.g. current binary path)
}
```

**Step rules:**
| Step | `skipped` when | `needed` when | `blocked` when |
|---|---|---|---|
| `fredo-path` | Fredo binary dir already in PATH | Not in PATH | N/A |
| `opencode-cli` | opencode found in PATH | N/A | opencode not found |
| `plugin-install` | plugin.json exists | Not installed | opencode not found (gate) |

**Command strings returned (platform-aware):**
- `fredo-path` (Windows): PowerShell script to add binary dir to user PATH
- `fredo-path` (Unix): `export PATH="<dir>:$PATH"` appended to shell rc files
- `plugin-install` (Windows): `copy <src> → ~/.config/opencode/plugins/fredo/` + `setx OPENCODE_ENABLE_TELEMETRY 1` + `setx OPENCODE_OTLP_ENDPOINT http://localhost:4317`
- `plugin-install` (Unix): copy command + export lines written to shell rc files

### Existing Commands (unchanged)
- `check_cli_installations` — still used internally by `get_setup_plan`
- `check_fredo_in_path` — still used internally
- `add_fredo_to_path` — called during execution
- `check_otel_configured` — still used internally
- `configure_otel` — still used internally
- `install_plugin` — called during execution

## Events Emitted
None. The setup wizard does not emit stream events. It calls Tauri commands directly.

## State Managed
- `screen`: `'detecting' | 'review' | 'executing' | 'done'` — wizard screen state
- `plan`: `SetupPlan | null` — result of `get_setup_plan`, null until detection completes
- `tasks`: `TaskState[]` — execution tracking per step (pending/running/done/error)

## Dependencies
- `adapterBridge.invoke()` for Tauri command calls (no direct `@tauri-apps/api` import)
- `@chakra-ui/react` — Box, Button, HStack, VStack, Text, Icon, Spinner, Code
- `react-icons/lu` — LuCircleCheck, LuCircleX, LuExternalLink, LuSettings2, LuLoader
- `settingsService` — for persisting `plugin_installed` flag (same as current)

## Forbidden Changes
- Do NOT add OTEL as a separate wizard step — it is bundled with plugin install
- Do NOT modify `SetupFeature.tsx` or `index.ts`
- Do NOT import `@tauri-apps/api` directly — use `adapterBridge`
- Do NOT remove or rename existing Tauri commands — they are still called during execution
- Do NOT add new npm dependencies