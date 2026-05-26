param(
  [Parameter(Mandatory=$true)][int]$TaskIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [string]$ParentIssue = 0
)

$branchName = "feat/$TaskIssue-$Slug"

git fetch origin
git checkout $SpecBranch
git checkout -b $branchName

Write-Host ""
Write-Host "Task claimed:"
Write-Host "  Task issue: #$TaskIssue"
Write-Host "  Branch: $branchName (from $SpecBranch)"