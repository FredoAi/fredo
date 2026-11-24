@echo off
rem QA fixture (issue #3198, AC1 / R-1a): a fake OpenCode 1.x on PATH.
rem Prints exactly one version line for --version and FAILS every other
rem invocation, so setup can neither build nor install against it.
rem It is a .cmd on purpose: it also exercises the `cmd.exe /C` shim rule the
rem version probe must reuse (terminal/commands.rs:244-264).
if /I "%~1"=="--version" (
  echo OpenCode 1.15.5
  exit /b 0
)
echo unsupported fixture invocation: %* 1>&2
exit /b 1
