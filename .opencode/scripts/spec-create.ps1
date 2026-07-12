param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Branch,
  [Parameter(Mandatory=$true)][string]$BodyFile,
  [Parameter(Mandatory=$true)][int]$BacklogIssue
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "spec-create.ps1" -IssueNumber "$BacklogIssue" -ScriptBlock {
  $cleanTitle = $Title -replace '^(BL#\d+-|SP#\d+-|BUG-SP#\d+-|SP-pending-)', ''

  if (-not (Test-Path $BodyFile)) {
    throw "Body file not found: $BodyFile"
  }

  $specComment = Get-Content $BodyFile -Raw

  $existingComments = gh issue view $BacklogIssue --comments 2>$null
  if ($LASTEXITCODE -eq 0 -and $existingComments -match '\*Authored by Architect\*') {
    Write-Host "Spec comment already exists on issue #$BacklogIssue — skipping duplicate"
  } else {
    powershell -File .opencode/scripts/git-ops-comment.ps1 -IssueNumber $BacklogIssue -BodyFile $BodyFile 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to post spec comment on issue #$BacklogIssue"
    }
    Write-Host "Spec posted as comment on backlog #$BacklogIssue"
  }
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
*Authored by Software Architect*
"@
  $specBranchName = "spec/$BacklogIssue-$Branch"
  $mergeBase = git merge-base main $specBranchName 2>&1
  if ($LASTEXITCODE -ne 0 -or -not $mergeBase) {
    throw "No common ancestor between 'main' and '$specBranchName'. Push commits to the branch before creating a PR."
  }

  $prBodyTemp = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $prBodyTemp -Value $prBody -Encoding UTF8
  $pr = gh pr create --draft --base main --head $specBranchName --title "SP#$BacklogIssue-$cleanTitle" --body-file $prBodyTemp 2>&1
  Remove-Item $prBodyTemp -ErrorAction SilentlyContinue

  $prNumber = ""
  if ($LASTEXITCODE -eq 0) {
    $prNumber = ($pr -split '\s+')[0] -replace '[^0-9]', ''
  }

  Write-Host ""
  Write-Host "Branch: spec/$BacklogIssue-$Branch"
  Write-Host "Project status: Planning"
  if ($prNumber) {
    Write-Host "Main PR: #$prNumber (draft)"
  } else {
    Write-Host "Main PR: failed to create - $pr"
  }
}