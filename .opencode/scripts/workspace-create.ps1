param(
  [Parameter(Mandatory=$true)][int]$BacklogIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [Parameter(Mandatory=$true)][string]$CapsuleName
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "workspace-create.ps1" -IssueNumber "$BacklogIssue" -ScriptBlock {
  $Slug = $CapsuleName -replace '\s+', '-' -replace '[^a-zA-Z0-9-]', ''
  $Slug = $Slug.ToLower() -replace '-+', '-'
  $branchName = "feat/$BacklogIssue-$Slug"
  $worktreeDir = ".worktrees"
  $worktreePath = "$worktreeDir/workspace-$BacklogIssue-$Slug"

  if (-not (Test-Path $worktreeDir)) {
    New-Item -ItemType Directory -Path $worktreeDir -Force | Out-Null
    Add-Content -Path "$worktreeDir/.gitignore" -Value "*" -Encoding UTF8
  }

  git fetch origin
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to fetch origin"
  }

  $branchExists = git branch -r --list "origin/$branchName" 2>&1
  if ($branchExists) {
    git worktree add $worktreePath $branchName
  } else {
    git worktree add $worktreePath -b $branchName "origin/$SpecBranch"
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create worktree at $worktreePath"
  }

  Write-Host ""
  Write-Host "Workspace created:"
  Write-Host "  Path: $worktreePath"
  Write-Host "  Branch: $branchName (from $SpecBranch)"
  Write-Host "  Backlog: #$BacklogIssue"
  Write-Host "  Capsule: $CapsuleName"
}