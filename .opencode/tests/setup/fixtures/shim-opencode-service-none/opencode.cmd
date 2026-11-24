@echo off
rem QA fixture (issue #3198, fix-plan addendum ST-A5 item 1, NO-SERVICE variant):
rem a fake OpenCode 2.x CLI reporting that no background service is running, so
rem the product must NOT restart (restart_needed => false for Absent | Unknown)
rem and must still report today's successful install.
rem
rem   --version        -> `opencode v2.4.1` (passes the version gate)
rem   service status   -> one line on stderr, exit 1  => no Running service
rem   service restart  -> journaled, exit 0  (a WRONG restart must be visible:
rem                       the receipt is ZERO journal entries)
rem   anything else    -> exit 1
rem
rem Reached through `.opencode/scripts/setup-version-shim.ps1 -ShimDir <this dir>`
rem (needs the L-1/ST-A6 shadow fix). No `.exe` fixture exists or may.
set "QJ=%FREDO_QA_SHIM_JOURNAL%"
if "%QJ%"=="" set "QJ=%TEMP%\fredo-3198-shim-journal.txt"
if /I "%~1"=="--version" (
  echo opencode v2.4.1
  exit /b 0
)
if /I "%~1"=="service" (
  if /I "%~2"=="status" (
    1>&2 echo no background service is running
    exit /b 1
  )
  if /I "%~2"=="restart" (
    >>"%QJ%" echo %*
    exit /b 0
  )
)
exit /b 1
