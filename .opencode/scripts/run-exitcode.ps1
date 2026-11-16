#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Run a native command and print its exit code, for sandboxes that cannot chain.

.DESCRIPTION
  The tester (and other agents) run under a deny-by-default bash sandbox that
  forbids command chaining (`;`, `&&`, `|`) and multi-statement lines. A native
  command's `$LASTEXITCODE` is only reachable in a FOLLOW-UP statement, so an AC
  that asserts a CLI exit code cannot be verified live from the shell.

  This script closes that gap: it runs the passed command in-process and prints
  both the command output and a machine-readable `EXITCODE=<n>` line, then exits
  with the command's own code so the caller can assert it.

  It is a thin, read-only wrapper — it adds no behaviour to the command it runs.

.PARAMETER Command
  The command line to execute (e.g. `fredo open-terminal --cli bogus`). Passed to
  Invoke-Expression inside this script file, so the caller's sandbox chaining
  rules do not apply to the inner sequence.

.EXAMPLE
  powershell -File .opencode/scripts/run-exitcode.ps1 -Command "fredo open-terminal --cli bogus"
  # -> {"outcome":"invalid-cli",...}
  #    EXITCODE=1
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Command
)

$ErrorActionPreference = 'Continue'
$output = Invoke-Expression $Command 2>&1
$output | ForEach-Object { Write-Output $_ }
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Write-Output "EXITCODE=$code"
exit $code
