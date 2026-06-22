param(
  [string]$IssueNumber = "",
  [string]$Since = "",
  [int]$Tail = 50,
  [switch]$Json
)

$projectRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $projectRoot) {
  Write-Error "Not in a git repository"
  exit 1
}

$logFile = Join-Path $projectRoot ".opencode\state\script-errors.jsonl"
if (-not (Test-Path $logFile)) {
  if ($Json) { Write-Output "[]" } else { Write-Host "No errors logged." }
  exit 0
}

$errors = Get-Content $logFile -Tail $Tail -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_ | ConvertFrom-Json } catch { $null }
} | Where-Object { $_ }

if ($IssueNumber) {
  $errors = $errors | Where-Object { $_.issue -eq $IssueNumber }
}

if ($Since) {
  $sinceDate = [DateTime]::Parse($Since)
  $errors = $errors | Where-Object { [DateTime]::Parse($_.timestamp) -ge $sinceDate }
}

if ($Json) {
  $errors | ConvertTo-Json -Compress | Write-Output
} else {
  $count = ($errors | Measure-Object).Count
  Write-Host "=== Script Errors ($count total) ==="
  Write-Host ""
  foreach ($e in $errors) {
    Write-Host "$($e.timestamp) [$($e.source)] $($e.message)" -ForegroundColor Red
    if ($e.issue) { Write-Host "  Issue: #$($e.issue)" }
    if ($e.exit_code) { Write-Host "  Exit: $($e.exit_code)" }
    if ($e.details) { Write-Host "  Details: $($e.details.Substring(0, [Math]::Min(120, $e.details.Length)))" }
    Write-Host ""
  }
}

exit 0
