@echo off
rem PTY fixture for AC4 / R-4.4: prints GitHub Copilot's own auth-failure copy,
rem then exits 0. Driven through the existing `terminal_copilot_path` diagnostic
rem override so no product seam is added.
echo GitHub Copilot CLI
echo You are not logged in. Please sign in.
exit /b 0
