param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Branch,
  [Parameter(Mandatory=$true)][string]$BodyFile,
  [Parameter(Mandatory=$true)][int]$ParentIssue
)

$Title = $Title -replace '^(BL#\d+-|SP#\d+-|BUG-SP#\d+-|SP-pending-)', ''

if (-not (Test-Path $BodyFile)) {
  Write-Error "Body file not found: $BodyFile"
  exit 1
}

$issue = gh issue create --title "SP-pending-$Title" --body-file $BodyFile --label "spec" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create issue: $issue"
  exit 1
}

$issueNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
if (-not $issueNumber) {
  $issueNumber = (gh issue list --limit 1 --json number -q '.[0].number')
}

$updatedTitle = "SP#$issueNumber-$Title"
gh issue edit $issueNumber --title $updatedTitle

$linkBody = "Spec: #$issueNumber"
$linkTemp = [System.IO.Path]::GetTempFileName()
Set-Content -Path $linkTemp -Value $linkBody -Encoding UTF8
gh issue comment $ParentIssue --body-file $linkTemp
Remove-Item $linkTemp -ErrorAction SilentlyContinue

git checkout main
git pull origin main
git checkout -b "spec/$issueNumber-$Branch"
git push -u origin "spec/$issueNumber-$Branch"

$prBody = @"
## Main Integration PR

Spec: #$issueNumber
Backlog: #$ParentIssue

This PR accumulates all workspace changes as they are merged into the spec branch.

---
*Authored by @fredo*
"@
$prBodyTemp = [System.IO.Path]::GetTempFileName()
Set-Content -Path $prBodyTemp -Value $prBody
$pr = gh pr create --draft --base main --head "spec/$issueNumber-$Branch" --title "SP#$issueNumber-$Title" --body-file $prBodyTemp --label "active" 2>&1
Remove-Item $prBodyTemp -ErrorAction SilentlyContinue

$prNumber = ""
if ($LASTEXITCODE -eq 0) {
  $prNumber = ($pr -split '\s+')[0] -replace '[^0-9]', ''
}

Remove-Item $BodyFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Spec created:"
Write-Host "  Issue: #$issueNumber (label: spec)"
Write-Host "  Branch: spec/$issueNumber-$Branch"
if ($prNumber) {
  Write-Host "  Main PR: #$prNumber (label: active, draft)"
} else {
  Write-Host "  Main PR: failed to create — $pr"
}
Write-Host "  Parent backlog: #$ParentIssue"
