param(
  [Parameter(Mandatory=$true)][int]$SpecIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch
)

git checkout main
git pull origin main
git merge --squash $SpecBranch
git commit -m "feat: spec #$SpecIssue implementation"
git push origin main

git branch -d $SpecBranch
git push origin --delete $SpecBranch 2>$null

$worktrees = git worktree list 2>$null | Select-String '.worktrees/'
foreach ($wt in $worktrees) {
  $wtPath = ($wt -split '\s+')[0]
  if (Test-Path $wtPath) {
    git worktree remove $wtPath --force 2>$null
  }
}

gh issue edit $SpecIssue --add-label "spec:done"

$specBody = gh issue view $SpecIssue --json body -q '.body'

$subtaskMatches = [regex]::Matches($specBody, '#(\d+)')
$uniqueTasks = @{}
foreach ($match in $subtaskMatches) {
  $num = [int]$match.Groups[1].Value
  if ($num -ne $SpecIssue) {
    $uniqueTasks[$num] = $true
  }
}

foreach ($taskNum in $uniqueTasks.Keys) {
  gh issue close $taskNum --reason completed 2>$null
}

$closeBody = @"
Spec #$SpecIssue implementation complete. Squash-merged to main.

Branch `$SpecBranch` deleted.

---
*Authored by @fredo*
"@
$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value $closeBody
gh issue close $SpecIssue --body-file $tempFile --reason completed
Remove-Item $tempFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Spec finalized:"
Write-Host "  Spec: #$SpecIssue (closed)"
Write-Host "  Squash-merged to main"
Write-Host "  Branch $SpecBranch deleted"