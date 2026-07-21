<#
.SYNOPSIS
  Cleans dev environment logs and script error log after successful spec completion.

.DESCRIPTION
  Called by the Self-Improver after a spec successfully completes (Step 8: Register Success).
  Truncates dev instance stdout/stderr logs and the script-errors.jsonl file.
  Every spec starts with a clean log slate.

.NOTES
  Part of the Self-Improvement gate. Do NOT call during active spec execution.
  Only clean after the spec is done and success is registered.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$opencodeDir = Join-Path $scriptDir ".."
$logsDir = Join-Path $opencodeDir "logs"
$stateDir = Join-Path $opencodeDir "state"

Write-Output "=== Cleaning logs ==="

# Truncate dev environment logs
$devLogs = @("dev-env-stderr.log", "dev-env-stdout.log")
foreach ($logFile in $devLogs) {
    $path = Join-Path $logsDir $logFile
    if (Test-Path -LiteralPath $path) {
        $size = (Get-Item -LiteralPath $path).Length
        Set-Content -LiteralPath $path -Value "" -NoNewline
        Write-Output "  Cleaned: $logFile (was $([math]::Round($size / 1KB, 1)) KB)"
    } else {
        Write-Output "  Skipped: $logFile (not found)"
    }
}

# Truncate script errors log
$errorsPath = Join-Path $stateDir "script-errors.jsonl"
if (Test-Path -LiteralPath $errorsPath) {
    $size = (Get-Item -LiteralPath $errorsPath).Length
    $entryCount = (Get-Content -LiteralPath $errorsPath | Measure-Object -Line).Lines
    Set-Content -LiteralPath $errorsPath -Value "" -NoNewline
    Write-Output "  Cleaned: script-errors.jsonl (was $([math]::Round($size / 1KB, 1)) KB, $entryCount entries)"
} else {
    Write-Output "  Skipped: script-errors.jsonl (not found)"
}

Write-Output ""
Write-Output "Log cleanup complete."
