@echo off
rem QA fixture (issue #3198, NFR-3 probe budget): --version outlives
rem VERSION_PROBE_TIMEOUT_MS (5 000 ms) so the probe's bound is exercised.
rem
rem `ping -n 8 127.0.0.1` (~7 s) is used instead of `timeout`, because timeout
rem refuses redirected stdin and the probe captures the child's output.
rem
rem Round-1 L-2 fix: `>nul 2>nul` (BOTH streams) - NOT `>nul` alone. The product
rem kills cmd.exe at its 5 000 ms bound (run_bounded kills only the direct child,
rem opencode_version.rs:369-384); ping survives as an orphan and, with stderr
rem still on the captured pipe, the *shell* kept that pipe open and the
rem invocation measured 7 270 ms - the fixture's plumbing, not the product,
rem decided the clock. Redirecting stdout AND stderr to NUL leaves the survivor
rem no handle to the captured pipe, so the invocation ends when the product's
rem bound fires.
rem
rem Single-line constructs only (no parenthesised block): a batch file with
rem LF-only endings must still parse the same way on every host.
if /I not "%~1"=="--version" exit /b 1
ping -n 8 127.0.0.1 >nul 2>nul
echo OpenCode 1.15.5
exit /b 0
