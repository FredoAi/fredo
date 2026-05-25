param(
  [Parameter(Mandatory=$true)][int]$PrNumber,
  [Parameter(Mandatory=$true)][int]$TaskIssue,
  [Parameter(Mandatory=$true)][int]$SpecIssue
)

$prBranch = gh pr view $PrNumber --json headRefName -q '.headRefName'

gh pr merge $PrNumber --squash --delete-branch

gh issue edit $TaskIssue --add-label "task:done" --remove-label "task:in-progress"

$closeBody = @"
Implementation complete. PR #$PrNumber merged.

---
*Authored by @fredo*
"@
$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value $closeBody
gh issue close $TaskIssue --body-file $tempFile --reason completed
Remove-Item $tempFile -ErrorAction SilentlyContinue

$specBody = gh issue view $SpecIssue --json body -q '.body'
if ($specBody -match "#$PrNumber \(DRAFT\)") {
  $updatedBody = $specBody -replace "#$PrNumber \(DRAFT\)", "#$PrNumber (MERGED)"
  $bodyTempFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $bodyTempFile -Value $updatedBody
  gh issue edit $SpecIssue --body-file $bodyTempFile
  Remove-Item $bodyTempFile -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "PR merged:"
Write-Host "  PR: #$PrNumber"
Write-Host "  Task: #$TaskIssue (closed)"
Write-Host "  Spec: #$SpecIssue"