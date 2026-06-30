param(
  [Parameter(Mandatory=$true)][ValidateSet("retro","metrics","both")][string]$Mode,
  [Parameter(Mandatory=$true)][int]$BacklogIssue,
  [Parameter(Mandatory=$true)][string]$BodyFile
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "retro-append.ps1" -IssueNumber "$BacklogIssue" -ScriptBlock {
  if (-not (Test-Path $BodyFile)) {
    throw "Body file not found: $BodyFile"
  }

  $content = Get-Content $BodyFile -Raw
  $projectRoot = (git rev-parse --show-toplevel 2>$null)
  if (-not $projectRoot) {
    throw "Not in a git repository"
  }

  if ($Mode -eq "retro" -or $Mode -eq "both") {
    $retroPath = Join-Path $projectRoot ".opencode\IMPROVEMENTS.md"
    if (-not (Test-Path $retroPath)) {
      throw "IMPROVEMENTS.md not found at $retroPath"
    }
    Add-Content -Path $retroPath -Value $content -Encoding UTF8
    Write-Host "Retro line appended to IMPROVEMENTS.md"
  }

  if ($Mode -eq "metrics" -or $Mode -eq "both") {
    $metricsPath = Join-Path $projectRoot ".opencode\metrics.json"
    if (-not (Test-Path $metricsPath)) {
      throw "metrics.json not found at $metricsPath"
    }

    $metrics = Get-Content $metricsPath -Raw | ConvertFrom-Json
    $key = "$BacklogIssue"
    $initialSpecCount = ($metrics.specs.PSObject.Properties | Measure-Object).Count

    $entry = $content | ConvertFrom-Json

    $metricsFresh = Get-Content $metricsPath -Raw | ConvertFrom-Json
    $freshSpecCount = ($metricsFresh.specs.PSObject.Properties | Measure-Object).Count

    if ($freshSpecCount -ne $initialSpecCount) {
      Write-Warning "metrics.json changed during append ($initialSpecCount -> $freshSpecCount specs). Merging into fresh copy."
      $metricsFresh.specs | Add-Member -MemberType NoteProperty -Name $key -Value $entry -Force
      $metricsFresh | ConvertTo-Json -Depth 10 | Set-Content -Path $metricsPath -Encoding UTF8
    } else {
      $metrics.specs | Add-Member -MemberType NoteProperty -Name $key -Value $entry -Force
      $metrics | ConvertTo-Json -Depth 10 | Set-Content -Path $metricsPath -Encoding UTF8
    }
    Write-Host "Metrics entry appended to metrics.json for Spec #$BacklogIssue"
  }

  if ($Mode -eq "metrics" -or $Mode -eq "both") {
    $errorLog = Join-Path $projectRoot ".opencode\state\script-errors.jsonl"
    if (Test-Path $errorLog) {
      $specErrors = Get-Content $errorLog -ErrorAction SilentlyContinue | Where-Object { $_ -match """issue"":\s*""$BacklogIssue""" }
      $errorCount = ($specErrors | Measure-Object).Count
      if ($errorCount -gt 0) {
        Write-Warning "SCRIPT ERRORS: $errorCount script error(s) logged for Spec #$BacklogIssue. See .opencode/state/script-errors.jsonl (filter issue:$BacklogIssue)."
      }
    }
  }
}