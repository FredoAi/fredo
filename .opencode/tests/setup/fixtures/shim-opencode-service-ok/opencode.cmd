@echo off
rem QA fixture (issue #3198, fix-plan addendum ST-A5 item 1): a fake OpenCode
rem 2.x CLI that the PRODUCT's own resolver picks, so `install_plugin`'s
rem write -> probe -> `service restart` dispatch runs for real with ZERO contact
rem with the real background service (which hosts the pipeline's own session and
rem must never be restarted - G-461).
rem
rem   --version        -> `opencode v2.4.1` (passes the version gate)
rem   service status   -> `http://127.0.0.1:28894`, exit 0  => Running
rem   service restart  -> exit 0 AND appends its argv to the journal file
rem                       (%FREDO_QA_SHIM_JOURNAL%, else
rem                        %TEMP%\fredo-3198-shim-journal.txt)
rem   anything else    -> exit 1
rem
rem Reached through `.opencode/scripts/setup-version-shim.ps1 -ShimDir <this
rem dir>` (needs the L-1/ST-A6 shadow fix: a `.cmd` only wins once the installed
rem `opencode.exe` is off the launched PATH). No `.exe` fixture exists or may:
rem a `.cmd` renamed `.exe` is not a PE image and CreateProcessW refuses it.
rem
rem Single-line / parenthesised constructs only, no labels: a batch file must
rem parse the same way whatever its line endings.
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
    exit /b 0
  )
)
exit /b 1
