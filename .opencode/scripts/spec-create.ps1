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

  $existingComments = gh issue view $BacklogIssue --comments 2>$null
  if ($LASTEXITCODE -eq 0 -and $existingComments -match '\*Authored by Software Architect\*') {
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

  Write-Host ""
  Write-Host "Branch: spec/$BacklogIssue-$Branch"
  Write-Host "Project status: Planning"
}