param(
  [Parameter(Mandatory=$true)][ValidateSet("approve","request-changes")][string]$Action,
  [Parameter(Mandatory=$true)][int]$PrNumber,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [string]$ReviewFile
)

if ($Action -eq "approve") {
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
  Set-Content -Path $tempFile -Value $reviewBody
  gh pr review $PrNumber --approve --body-file $tempFile
  gh pr edit $PrNumber --add-label "pr:approved" --remove-label "pr:needs-review"
  Remove-Item $tempFile -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "PR #$PrNumber approved"
}

if ($Action -eq "request-changes") {
  if (-not $ReviewFile) {
    Write-Error "ReviewFile is required for request-changes action"
    exit 1
  }

  $reviewBody = Get-Content $ReviewFile -Raw
  $tempFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tempFile -Value $reviewBody
  gh pr review $PrNumber --request-changes --body-file $tempFile
  gh pr edit $PrNumber --add-label "pr:changes-requested" --remove-label "pr:needs-review"
  Remove-Item $tempFile -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "Changes requested on PR #$PrNumber"
}

if (Test-Path $ReviewFile) {
  Remove-Item $ReviewFile -ErrorAction SilentlyContinue
}