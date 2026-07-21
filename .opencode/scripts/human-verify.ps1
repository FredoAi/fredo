param(
  [Parameter(Mandatory = $true)][int]$BacklogIssue,
  [switch]$Verified,
  [switch]$Leaky,
  [string]$Reason = "",
  [switch]$Status
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "human-verify.ps1" -IssueNumber "$BacklogIssue" -ScriptBlock {
  $projectRoot = (git rev-parse --show-toplevel 2>$null)
  if (-not $projectRoot) { throw "Not in a git repository" }

  $metricsPath = Join-Path $projectRoot ".opencode\metrics.json"
  if (-not (Test-Path $metricsPath)) { throw "metrics.json not found" }

  $metrics = Get-Content $metricsPath -Raw | ConvertFrom-Json
  $key = "$BacklogIssue"

  if (-not ($metrics.specs.$key)) {
    throw "Spec #$BacklogIssue not found in metrics.json"
  }

  if ($Status) {
    $spec = $metrics.specs.$key
    $result = if ($spec.result) { $spec.result } else { "not set" }
    $humanVerified = if ($spec.human_verified) { "yes" } else { "no" }
    Write-Host ""
    Write-Host "Spec #$BacklogIssue"
    Write-Host "  result: $result"
    Write-Host "  human_verified: $humanVerified"
    if ($spec.leaky_reason) {
      Write-Host "  leaky_reason: $($spec.leaky_reason)"
    }
    Write-Host ""
    return
  }

  if (-not $Verified -and -not $Leaky) {
    throw "Use -Verified to confirm or -Leaky to flag issues. Use -Status to check current state."
  }

  if ($Verified -and $Leaky) {
    throw "Use either -Verified or -Leaky, not both."
  }

  $tempFile = Join-Path $projectRoot ".opencode\tmp\human-verify-$BacklogIssue.json"
  $tmpDir = Split-Path $tempFile -Parent
  if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null }

  if ($Verified) {
    $update = @{
      human_verified = $true
      result = if ($metrics.specs.$key.result -eq "leaky") { "accepted" } else { $metrics.specs.$key.result }
    }
    Write-Host "Marking Spec #$BacklogIssue as human-verified."
  }

  if ($Leaky) {
    $update = @{
      result = "leaky"
      human_verified = $false
      leaky_reason = if ($Reason -ne "") { $Reason } else { "Unspecified - human found issues during manual testing" }
    }
    Write-Host "Marking Spec #$BacklogIssue as leaky."
    if ($Reason) { Write-Host "Reason: $Reason" }
  }

  $update | ConvertTo-Json -Depth 5 | Set-Content -Path $tempFile -Encoding UTF8

  Write-Host "Writing update to metrics.json..."

  $existing = $metrics.specs.$key
  $existing | Add-Member -MemberType NoteProperty -Name "human_verified" -Value $update.human_verified -Force

  if ($update.result) {
    $existing | Add-Member -MemberType NoteProperty -Name "result" -Value $update.result -Force
  }
  if ($update.leaky_reason) {
    $existing | Add-Member -MemberType NoteProperty -Name "leaky_reason" -Value $update.leaky_reason -Force
  }

  $metrics | ConvertTo-Json -Depth 10 | Set-Content -Path $metricsPath -Encoding UTF8

  Remove-Item $tempFile -ErrorAction SilentlyContinue

  Write-Host "Done. Spec #$BacklogIssue updated."
}
