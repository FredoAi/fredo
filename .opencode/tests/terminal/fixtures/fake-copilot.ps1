# =============================================================================
# TEST FIXTURE (Spec #2940 ST-5 / Architect C-6) — NOT the GitHub Copilot CLI.
# Never shipped in product code; lives only under the terminal test fixtures.
#
# Its only job is to be a `.ps1` target so `plan_launch` (commands.rs) picks
# `LaunchForm::PowerShellScript` — the ONE launch form for which the Copilot
# pwsh gate applies — which is what lets `slow-pwsh.cmd` (set as
# `terminal_pwsh_path`) hold `prepare_session` inside that gate for ~20 s.
# The forcing recipe never actually executes this file (the gate rejects the
# host first); if run directly it just prints an obviously-fake banner.
# =============================================================================
Write-Output 'fredo test fixture: fake-copilot.ps1 (not the GitHub Copilot CLI)'
