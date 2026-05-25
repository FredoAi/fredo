param(
  [Parameter(Mandatory=$true)][int]$TaskIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [Parameter(Mandatory=$true)][string]$Slug
)

$branchName = "feat/$TaskIssue-$Slug"

gh issue edit $TaskIssue --add-label "task:in-progress" --remove-label "task:available"

git fetch origin
git checkout $SpecBranch
git checkout -b $branchName

Write-Host ""
Write-Host "Task claimed:"
Write-Host "  Task issue: #$TaskIssue"
Write-Host "  Branch: $branchName (from $SpecBranch)"