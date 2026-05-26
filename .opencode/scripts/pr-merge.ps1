param(
  [Parameter(Mandatory=$true)][int]$PrNumber,
  [Parameter(Mandatory=$true)][int]$TaskIssue,
  [Parameter(Mandatory=$true)][int]$SpecIssue
)

$prLabels = gh pr view $PrNumber --json labels -q '.labels[].name'
if ($prLabels -notcontains "pr:approved") {
  Write-Error "PR #$PrNumber does not have the pr:approved label. Cannot merge."
  Write-Error "Reviewer must approve this PR before merging."
  exit 1
}

$ciChecks = gh pr checks $PrNumber 2>&1
if ($LASTEXITCODE -eq 0) {
  $failingChecks = $ciChecks | Where-Object { $_ -match 'fail' -or $_ -match 'error' }
  if ($failingChecks) {
    Write-Error "CI checks failing on PR #$PrNumber. Cannot merge until CI passes."
    Write-Error "Failing checks:"
    $failingChecks | ForEach-Object { Write-Error "  $_" }
    exit 1
  }
}

$prBranch = gh pr view $PrNumber --json headRefName -q '.headRefName'

gh pr merge $PrNumber --squash --delete-branch

$closeBody = @"
Implementation complete. PR #$PrNumber merged.

---
*Authored by @fredo*
"@
$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value $closeBody
gh issue close $TaskIssue --body-file $tempFile --reason completed
Remove-Item $tempFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "PR merged:"
Write-Host "  PR: #$PrNumber"
Write-Host "  Task: #$TaskIssue (closed)"
Write-Host "  Spec: #$SpecIssue"