param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Message,
  [string]$ExitCode = "",
  [string]$IssueNumber = "",
  [string]$Details = ""
)

$projectRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $projectRoot) {
  Write-Error "log-error: not in a git repository"
  exit 0
}

$stateDir = Join-Path $projectRoot ".opencode\state"
if (-not (Test-Path $stateDir)) {
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}

$logFile = Join-Path $stateDir "script-errors.jsonl"

$entry = @{
  timestamp = (Get-Date -Format "o")
  source = $Source
  message = $Message
  exit_code = if ($ExitCode) { "$ExitCode" } else { "" }
  issue = if ($IssueNumber) { "$IssueNumber" } else { "" }
  details = if ($Details) { $Details.Substring(0, [Math]::Min(500, $Details.Length)) } else { "" }
  branch = (git branch --show-current 2>$null)
}

$json = $entry | ConvertTo-Json -Compress
Add-Content -Path $logFile -Value $json -Encoding UTF8

Write-Warning "ERROR LOGGED: $Source — $Message"
exit $LASTEXITCODE
