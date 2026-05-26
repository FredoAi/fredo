param(
  [Parameter(Mandatory=$true)][int]$SpecIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch
)

$specLabels = gh issue view $SpecIssue --json labels -q '.labels[].name'
if ($specLabels -notcontains "spec:ready-for-e2e") {
  Write-Error "Spec #$SpecIssue does not have the spec:ready-for-e2e label."
  Write-Error "All PRs must be merged by the Reviewer before finalizing."
  exit 1
}

$openTasks = gh issue list --search "spec #$SpecIssue is:open" --json number,state -q '.[].number' 2>&1
if ($openTasks) {
  Write-Error "There are still open task issues for spec #$SpecIssue."
  Write-Error "Close all task issues before finalizing."
  Write-Error "Open tasks: $openTasks"
  exit 1
}

git checkout main
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to checkout main"
  exit 1
}

git pull origin main
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to pull main"
  exit 1
}

git merge --squash $SpecBranch
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to squash-merge $SpecBranch into main. Resolve conflicts manually."
  exit 1
}

git commit -m "feat: spec #$SpecIssue implementation"
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to commit squash merge"
  exit 1
}

git push origin main
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to push to main"
  exit 1
}

git branch -d $SpecBranch 2>$null
git push origin --delete $SpecBranch 2>$null

$worktrees = git worktree list 2>$null | Select-String '.worktrees/'
foreach ($wt in $worktrees) {
  $wtPath = ($wt -split '\s+')[0]
  if (Test-Path $wtPath) {
    git worktree remove $wtPath --force 2>$null
  }
}

$closeBody = @"
Spec #$SpecIssue implementation complete. Squash-merged to main.

Branch `$SpecBranch` deleted.

**Retrospective:** Update `.opencode/IMPROVEMENTS.md` with any learnings from this spec.

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
Write-Host ""
Write-Host "Don't forget to run a retrospective and update .opencode/IMPROVEMENTS.md"