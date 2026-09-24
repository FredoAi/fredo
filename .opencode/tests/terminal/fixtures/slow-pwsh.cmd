@echo off
rem ============================================================================
rem TEST FIXTURE (Spec #2940 ST-5 / Architect C-6) — NOT a real PowerShell.
rem Never shipped in product code; lives only under the terminal test fixtures.
rem
rem Used as the `terminal_pwsh_path` diagnostic override so prepare_session's
rem Copilot pwsh gate (commands.rs `check_powershell_prereq`) RUNS this script
rem and blocks ~20 s inside it. The extra time (well past the 10 s Doherty bound)
rem lets the tester observe `terminal-starting-state` + the slow-start hint while
rem the session status is still `starting`.
rem
rem Ignores every argument the gate passes; prints `5` (an unsupported PowerShell
rem major) on stdout and exits 0, so the gate deterministically classifies the
rem launch as `prereq`. `ping` is the portable Windows sleep — `timeout` refuses
rem to run when stdin is redirected, as it is for the gate's captured output.
rem ============================================================================
ping -n 21 127.0.0.1 >nul
echo 5
exit /b 0
