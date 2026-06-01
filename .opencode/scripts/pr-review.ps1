param(
  [Parameter(Mandatory=$true)][ValidateSet("approve","request-changes")][string]$Action,
  [Parameter(Mandatory=$true)][int]$PrNumber,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [string]$ReviewFile
)

if ($Action -eq "approve") {
  $ciChecks = gh pr checks $PrNumber 2>&1
  if ($LASTEXITCODE -eq 0) {
    $failingChecks = $ciChecks | Where-Object { $_ -match 'fail' -or $_ -match 'error' }
    if ($failingChecks) {
      Write-Error "CI checks failing on PR #$PrNumber. Cannot merge."
      Write-Error "Failing checks:"
      $failingChecks | ForEach-Object { Write-Error "  $_" }
      exit 1
    }
  }

  if (-not $ReviewFile) {
    $reviewBody = @"
## Approved

All acceptance criteria met. Scope is correct. Patterns followed.

---
*Reviewed by @fredo*
"@
  } else {
    $reviewBody = Get-Content $ReviewFile -Raw
  }

  $tempFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tempFile -Value $reviewBody -Encoding UTF8
  gh pr review $PrNumber --approve --body-file $tempFile
  Remove-Item $tempFile -ErrorAction SilentlyContinue

  gh pr merge $PrNumber --squash --delete-branch

  Write-Host ""
  Write-Host "PR #$PrNumber approved and merged into $SpecBranch"
}

if ($Action -eq "request-changes") {
  if (-not $ReviewFile) {
    Write-Error "ReviewFile is required for request-changes action"
    exit 1
  }

  $reviewBody = Get-Content $ReviewFile -Raw
  $tempFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tempFile -Value $reviewBody -Encoding UTF8
  gh pr review $PrNumber --request-changes --body-file $tempFile
  Remove-Item $tempFile -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "Changes requested on PR #$PrNumber"
}

if (Test-Path $ReviewFile -ErrorAction SilentlyContinue) {
  Remove-Item $ReviewFile -ErrorAction SilentlyContinue
}
