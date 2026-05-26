# ADR-79: Fix Setup PowerShell 5.1 Compatibility and Re-detection Logic

## Status
Proposed

## Context
The Setup wizard's `check_fredo_in_path` command runs a PowerShell script to read the User and Machine PATH environment variables. The script uses the `??` (null-coalescing) operator, which is a PowerShell 7+ feature. On Windows, the app spawns `powershell.exe` (Windows PowerShell 5.1), which does not support `??`. The script fails silently, returning an empty string, so `check_fredo_in_path` always reports `in_path: false` — even after `add_fredo_to_path` successfully writes to the registry.

This causes an infinite loop: the wizard shows "Add Fredo CLI to PATH" as needed → user clicks Continue → step completes with green checkmark → user reopens wizard → step is shown as needed again.

Additionally, the `Home.tsx` auto-open trigger reads `plugin_installed` from settings, but the backend `get_setup_plan` never reads this flag — it re-derives state from filesystem checks. This is correct behavior (source of truth should be the actual system state), but it means the PATH detection bug blocks all downstream detection.

## Decision
1. Replace the `??` null-coalescing operator in the `check_fredo_in_path` PowerShell script with PowerShell 5.1-compatible null checks (`if (-not $var) { $var = '' }`).
2. No interface changes — the `FredoPathStatus`, `SetupPlan`, and command signatures remain identical. This is a fix to internal implementation only.

## Consequences
### Positive
- Setup wizard correctly detects Fredo CLI in PATH after successful installation on Windows
- First-time users can complete setup once and not be prompted again
- Auto-open trigger on Home.tsx converges properly (plugin_installed + backend check align)

### Negative
- None — this is a bug fix with no interface changes

### Risks
- Low risk: the fix is a one-line PowerShell script change, well-scoped to the single affected function