@echo off
rem QA fixture (issue #3198, NFR-3 probe budget): --version outlives
rem VERSION_PROBE_TIMEOUT_MS (5 000 ms) so the probe's bound is exercised.
rem `ping -n 8 127.0.0.1` is used instead of `timeout`, because timeout
rem refuses redirected stdin and the probe captures the child's output.
if /I "%~1"=="--version" (
  ping -n 8 127.0.0.1 >nul
  echo OpenCode 1.15.5
  exit /b 0
)
exit /b 1
