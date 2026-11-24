@echo off
rem QA fixture (issue #3198, AC1 / R-1a): a fake OpenCode 1.x on PATH.
rem Prints exactly one version line for --version and FAILS every other
rem invocation, so setup can neither build nor install against it.
rem It is a .cmd on purpose: it also exercises the `cmd.exe /C` shim rule the
rem version probe must reuse (terminal/commands.rs:244-264).
rem
rem Round-1 L-1: this file CANNOT win alone. The product probes
rem `where opencode.exe` before `opencode.cmd`, and `where.exe` scans the WHOLE
rem PATH per candidate, so an installed opencode.exe anywhere on PATH shadows
rem it. Reached through the committed forwarder
rem `.opencode/scripts/setup-version-shim.ps1`, which drops every PATH entry that
rem resolves an `opencode.*`; gate each leg on the PRODUCT payload's
rem `binary_path` resolving inside this directory (never on a fixture named
rem `opencode.exe` - a `.cmd` renamed `.exe` is not a PE image).
if /I "%~1"=="--version" (
  echo OpenCode 1.15.5
  exit /b 0
)
echo unsupported fixture invocation: %* 1>&2
exit /b 1
