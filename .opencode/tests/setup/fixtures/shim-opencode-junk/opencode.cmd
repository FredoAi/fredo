@echo off
rem QA fixture (issue #3198, AC1 / R-1b): --version succeeds but prints no
rem version token, so parse_major() returns None (unparseable output).
if /I "%~1"=="--version" (
  echo hello from a fake cli
  exit /b 0
)
exit /b 1
