<#
.SYNOPSIS
Pre-commit guard script — blocks commits to main branch.
Install: copy to .git/hooks/pre-commit (no extension) or set core.hooksPath.
#>

$branch = git branch --show-current 2>$null
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  Write-Error "pre-commit: Failed to determine current branch."
  exit 1
}

$protectedBranches = @("main", "master")

if ($protectedBranches -contains $branch) {
  Write-Error "pre-commit BLOCKED: Commits to '$branch' are forbidden.`nSwitch to a spec branch or worktree before committing.`n  git switch spec/<N>-<slug>"
  exit 1
}

exit 0
