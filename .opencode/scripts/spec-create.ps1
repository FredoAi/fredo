param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Branch,
  [Parameter(Mandatory=$true)][string]$BodyFile,
  [Parameter(Mandatory=$true)][int]$BacklogIssue
)

$Title = $Title -replace '^(BL#\d+-|SP#\d+-|BUG-SP#\d+-|SP-pending-)', ''

if (-not (Test-Path $BodyFile)) {
  Write-Error "Body file not found: $BodyFile"
  exit 1
}

$specComment = Get-Content $BodyFile -Raw
$commentTemp = [System.IO.Path]::GetTempFileName()
Set-Content -Path $commentTemp -Value $specComment -Encoding UTF8
gh issue comment $BacklogIssue --body-file $commentTemp
Remove-Item $commentTemp -ErrorAction SilentlyContinue
Remove-Item $BodyFile -ErrorAction SilentlyContinue

powershell -File .opencode/scripts/project-status.ps1 -IssueNumber $BacklogIssue -Status "Planning"

git checkout main
git pull origin main
git checkout -b "spec/$BacklogIssue-$Branch"
git push -u origin "spec/$BacklogIssue-$Branch"

$prBody = @"
## Main Integration PR

Backlog: #$BacklogIssue

This PR accumulates all workspace changes as they are merged into the spec branch.

---
*Authored by Architect*
"@
$prBodyTemp = [System.IO.Path]::GetTempFileName()
Set-Content -Path $prBodyTemp -Value $prBody -Encoding UTF8
$pr = gh pr create --draft --base main --head "spec/$BacklogIssue-$Branch" --title "SP#$BacklogIssue-$Title" --body-file $prBodyTemp 2>&1
Remove-Item $prBodyTemp -ErrorAction SilentlyContinue

$prNumber = ""
if ($LASTEXITCODE -eq 0) {
  $prNumber = ($pr -split '\s+')[0] -replace '[^0-9]', ''
}

Write-Host ""
Write-Host "Spec posted as comment on backlog #$BacklogIssue"
Write-Host "Branch: spec/$BacklogIssue-$Branch"
Write-Host "Project status: Planning"
if ($prNumber) {
  Write-Host "Main PR: #$prNumber (draft)"
} else {
  Write-Host "Main PR: failed to create - $pr"
}
