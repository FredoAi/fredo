param(
  [Parameter(Mandatory=$true)][string]$Tool,
  [Parameter(Mandatory=$true)][string]$Error,
  [string]$Issue = "",
  [string]$Agent = ""
)

$logDir = Join-Path $PSScriptRoot ".." "state"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$entry = @{
  tool      = $Tool
  error     = $Error
  issue     = $Issue
  agent     = $Agent
  timestamp = (Get-Date -Format "o")
} | ConvertTo-Json -Compress

$logFile = Join-Path $logDir "mcp-errors.jsonl"
Add-Content -Path $logFile -Value $entry

Write-Host "MCP error logged: $Tool — $Error"
