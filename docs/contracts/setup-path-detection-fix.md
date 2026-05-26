# Contract: Setup Path Detection Fix

## Public Interface
No changes to public interface. All existing Tauri commands, return types, and frontend contracts remain identical:

- `check_fredo_in_path() -> FredoPathStatus { in_path: bool, binary_path: String }` — unchanged
- `get_setup_plan(app: AppHandle) -> SetupPlan { steps, can_proceed, opencode_docs_url }` — unchanged
- `add_fredo_to_path() -> InstallResult` — unchanged

## Events Emitted
None. This fix is internal to setup detection; no new events are emitted.

## State Managed
No new state. Existing state remains:
- `settingsService.set('plugin_installed', 'true')` — written by SetupWizard after plugin install (unchanged)
- Registry PATH entry — written by `add_fredo_to_path` via `SetEnvironmentVariable` (unchanged)

## Dependencies
- Windows PowerShell 5.1 (`powershell.exe`) — must remain the runtime target; no dependency on PowerShell 7+

## Forbidden Changes
- Do not change the `FredoPathStatus`, `SetupPlan`, or `InstallResult` return types
- Do not change the `get_setup_plan`, `check_fredo_in_path`, or `add_fredo_to_path` command signatures
- Do not switch from `powershell.exe` to `pwsh.exe` (not guaranteed on all Windows machines)
- Do not add PowerShell 7 as a dependency