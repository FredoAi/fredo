#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Run a native command and print its exit code, for sandboxes that cannot chain.

.DESCRIPTION
  The tester (and other agents) run under a deny-by-default bash sandbox that
  forbids command chaining (`;`, `&&`, `|`) and multi-statement lines. A native
  command's `$LASTEXITCODE` is only reachable in a FOLLOW-UP statement, so an AC
  that asserts a CLI exit code cannot be verified live from the shell.

  This script closes that gap: it runs the passed command and prints both the
  command output and a machine-readable `EXITCODE=<n>` line, then exits with the
  command's own code so the caller can assert it.

  It is a thin wrapper -- it adds no behaviour to the command it runs.

  NO END-OF-FILE DEPENDENCE (Spec #3181 round 3, guardrail G-450). The command is
  written VERBATIM (no re-quoting across the transport, G-447) to a temp .ps1 with
  an appended `exit $LASTEXITCODE` line and run as a DETACHED child whose
  stdout/stderr are redirected to two temp FILES. The direct child is awaited with
  a bounded Wait-DetachedChild, so a grandchild that holds the child's output pipe
  can never block this wrapper: a COMPLETED child always yields both its captured
  text and its `EXITCODE=` line, and a runaway child is bounded by -TimeoutSecs.

.PARAMETER Command
  The command line to execute (e.g. `fredo open-terminal --cli bogus`). Written
  verbatim into a temp .ps1, so the caller's sandbox chaining rules do not apply
  to the inner sequence.

.PARAMETER TimeoutSecs
  Upper bound on the child run, seconds. Default 1800 (the worst release-gate run:
  630 s fresh + 210 s dirty + payload; negatives run separately). On expiry the
  output captured so far is printed, then `TIMEOUT=<secs>` and
  `EXITCODE=timeout`, and the wrapper exits 1.

.EXAMPLE
  powershell -File .opencode/scripts/run-exitcode.ps1 -Command "fredo open-terminal --cli bogus"
  # -> {"outcome":"invalid-cli",...}
  #    EXITCODE=1

.EXAMPLE
  powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -SelfTest"
  # -> ... SELFTEST: PASS
  #    EXITCODE=0
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [int]$TimeoutSecs = 1800
)

$ErrorActionPreference = 'Continue'

# The ONE handle-whitelist spawn (G-450).
Import-Module (Join-Path $PSScriptRoot 'detach-process.psm1') -ErrorAction Stop

$tempRoot = [System.IO.Path]::GetTempPath()
$stamp = [Guid]::NewGuid().ToString('N')
$scriptPath = Join-Path $tempRoot ('fredo-run-exitcode-' + $stamp + '.ps1')
$stdoutPath = Join-Path $tempRoot ('fredo-run-exitcode-' + $stamp + '.stdout.log')
$stderrPath = Join-Path $tempRoot ('fredo-run-exitcode-' + $stamp + '.stderr.log')

# Verbatim transport (G-447): append the exit propagation line without rewriting
# the caller's command string. UTF-8 WITH BOM so PowerShell 5.1 decodes non-ASCII
# content correctly (G-315).
$trailer = "`r`nif (`$null -ne `$LASTEXITCODE) { exit `$LASTEXITCODE } else { exit 0 }`r`n"
[System.IO.File]::WriteAllText($scriptPath, ($Command + $trailer), (New-Object System.Text.UTF8Encoding($true)))

$hostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argString = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '"'

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$childPid = 0
try {
    # cwd is inherited from this wrapper (= the caller's cwd), so relative paths in
    # the command resolve exactly as they did in-process.
    $childPid = Start-DetachedProcess -FilePath $hostExe -ArgumentString $argString -StdOutPath $stdoutPath -StdErrPath $stderrPath
} catch {
    Write-Output ('ERROR: child launch failed: ' + $_.Exception.Message)
    Write-Output 'EXITCODE=error'
    exit 1
}

$code = Wait-DetachedChild -ProcessId $childPid -TimeoutSecs $TimeoutSecs
$watch.Stop()

$stdoutText = ''
$stderrText = ''
# Read with FILE_SHARE_READ|WRITE: the spawn helper opens the child's stdout/stderr
# with a WRITE handle that a grandchild may still hold (the very inheritance this
# wrapper guards against); File.ReadAllText's default FileShare.Read would throw a
# sharing violation and lose a completed child's transcript.
function Read-SharedText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $stream = $null
    $reader = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $reader = New-Object System.IO.StreamReader($stream)
        return $reader.ReadToEnd()
    } catch {
        return ''
    } finally {
        if ($null -ne $reader) { $reader.Dispose() } elseif ($null -ne $stream) { $stream.Dispose() }
    }
}
$stdoutText = Read-SharedText -Path $stdoutPath
$stderrText = Read-SharedText -Path $stderrPath

# ALWAYS surface the captured transcript, completed or bounded-out.
if (-not [string]::IsNullOrEmpty($stdoutText)) { Write-Output $stdoutText }
if (-not [string]::IsNullOrEmpty($stderrText)) { Write-Output $stderrText }

if ($null -eq $code) {
    if ($watch.Elapsed.TotalSeconds -ge [Math]::Max(1, ($TimeoutSecs - 1))) {
        if ($childPid -gt 0) { try { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue } catch {} }
        Write-Output ('TIMEOUT=' + $TimeoutSecs)
        Write-Output 'EXITCODE=timeout'
        exit 1
    }
    Write-Output 'EXITCODE=error'
    exit 1
}

$code = [int]$code
Write-Output ('EXITCODE=' + $code)
try { Remove-Item -LiteralPath $scriptPath, $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue } catch {}
exit $code
