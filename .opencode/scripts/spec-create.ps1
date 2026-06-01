param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Branch,
  [Parameter(Mandatory=$true)][string]$BodyFile,
  [Parameter(Mandatory=$true)][int]$ParentIssue
)

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

git checkout main
git pull origin main
git checkout -b "spec/$issueNumber-$Branch"
git push -u origin "spec/$issueNumber-$Branch"

$pr = gh pr create --draft --base main --head "spec/$issueNumber-$Branch" --title "SP#$issueNumber-$Title" --body @"
## Main Integration PR

Spec: #$issueNumber
Backlog: #$ParentIssue

This PR accumulates all workspace changes as they are merged into the spec branch.

---
*Authored by @fredo*
"@ --label "active" 2>&1

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
