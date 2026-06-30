param()

function Invoke-WithLogging {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][ScriptBlock]$ScriptBlock,
    [int]$ExpectedExitCode = 0,
    [string]$IssueNumber = ""
  )

  $ErrorActionPreference = 'Stop'

  $errorMsg = $null
  $exitCode = 0

  try {
    & $ScriptBlock
    if ($LASTEXITCODE) { $exitCode = $LASTEXITCODE } else { $exitCode = 0 }
  } catch {
    $errorMsg = $_.Exception.Message
    $exitCode = 1
  }

  if ($exitCode -ne $ExpectedExitCode) {
    if (-not $errorMsg) {
      $errorMsg = "nonzero exit $exitCode from external command"
    }

    Write-Error "[$Source] $errorMsg" -ErrorAction Continue

    $projectRoot = (git rev-parse --show-toplevel 2>$null)
    if ($projectRoot) {
      $stateDir = Join-Path $projectRoot ".opencode\state"
      if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
      }
      $logFile = Join-Path $stateDir "script-errors.jsonl"

      $message = $errorMsg.Substring(0, [Math]::Min(500, $errorMsg.Length))

      $entry = @{
        timestamp = (Get-Date -Format "o")
        source    = $Source
        message   = $message
        exit_code = "$exitCode"
        issue     = if ($IssueNumber) { "$IssueNumber" } else { "" }
        branch    = (git branch --show-current 2>$null)
      }

      $entry | ConvertTo-Json -Compress | Add-Content -Path $logFile -Encoding UTF8
    }
  }

  exit $exitCode
}

function Repair-Json {
  param([string]$Json)
  try {
    $null = $Json | ConvertFrom-Json
    return @{ Json = $Json; Repaired = $false }
  } catch {
    $open = ($Json.ToCharArray() | Where-Object { $_ -eq '{' }).Count
    $close = ($Json.ToCharArray() | Where-Object { $_ -eq '}' }).Count
    if ($open -gt $close) {
      $Json += ('}' * ($open - $close))
    }
    try {
      $null = $Json | ConvertFrom-Json
      return @{ Json = $Json; Repaired = $true }
    } catch {
      return @{ Json = $null; Repaired = $false }
    }
  }
}