param(
  [Parameter(Mandatory=$true)][int]$TaskIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [Parameter(Mandatory=$true)][string]$Slug
)

$branchName = "feat/$TaskIssue-$Slug"
$worktreePath = "../workspace-$TaskIssue-$Slug"

git fetch origin

$branchExists = git branch -r --list "origin/$branchName" 2>&1
if ($branchExists) {
  git worktree add $worktreePath $branchName
} else {
  git worktree add $worktreePath -b $branchName "origin/$SpecBranch"
}

Write-Host ""
Write-Host "Workspace created:"
Write-Host "  Path: $worktreePath"
Write-Host "  Branch: $branchName (from $SpecBranch)"
Write-Host "  Task issue: #$TaskIssue"
