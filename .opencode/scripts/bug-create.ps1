param(
  [Parameter(Mandatory=$true)][int]$SpecIssue,
  [Parameter(Mandatory=$true)][int]$TaskIssue,
  [Parameter(Mandatory=$true)][int]$PrNumber,
  [Parameter(Mandatory=$true)][string]$Summary,
  [Parameter(Mandatory=$true)][string]$RootCause
)

$bugBody = @"
## Bug — Max Retries Exhausted

**Spec:** #$SpecIssue
**Task:** #$TaskIssue
**PR:** #$PrNumber

### What Happened

$Summary

### Root Cause

$RootCause

---
*Authored by @fredo*
"@

$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value $bugBody -Encoding UTF8

$titleSummary = if ($Summary.Length -gt 60) { $Summary.Substring(0, 60) } else { $Summary }

$issue = gh issue create --title "BUG-SP#$SpecIssue-Task#$TaskIssue-$titleSummary" --body-file $tempFile --label "bug" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create bug issue: $issue"
  Remove-Item $tempFile -ErrorAction SilentlyContinue
  exit 1
}

$bugNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
if (-not $bugNumber) {
  $bugNumber = (gh issue list --limit 1 --json number -q '.[0].number')
}

Remove-Item $tempFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Bug created:"
Write-Host "  Issue: #$bugNumber (label: bug)"
Write-Host "  Spec: #$SpecIssue"
Write-Host "  Task: #$TaskIssue"
Write-Host "  PR: #$PrNumber"
