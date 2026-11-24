@echo off
rem QA fixture (issue #3198, fix-plan addendum ST-A5 item 1, FAILURE variant):
rem a fake OpenCode 2.x CLI whose `service restart` fails, so the product's
rem failure path (ST-A2 item 2) is driven end-to-end with no contact with the
rem real background service.
rem
rem   --version        -> `opencode v2.4.1` (passes the version gate)
rem   service status   -> `http://127.0.0.1:28894`, exit 0  => Running (so a
rem                       restart IS attempted)
rem   service restart  -> one line on stderr, exit 2  => the restart FAILED
rem   anything else    -> exit 1
rem
rem EXPECTED product behaviour when this fixture is the resolved opencode:
rem `InstallResult.success == false`, the error is
rem `OPENCODE_SERVICE_RESTART_FAILED_MSG` rendered with this child's detail
rem (`(exit code 2) OpenCode service restart is unavailable in this build`),
rem the CLI exits 1 through `fail_step`, and the copied `fredo.js` STAYS on disk.
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
    echo http://127.0.0.1:28894
    exit /b 0
  )
  if /I "%~2"=="restart" (
    >>"%QJ%" echo %*
    1>&2 echo OpenCode service restart is unavailable in this build
    exit /b 2
  )
)
exit /b 1
