# Block direct commits to main/master — pipeline work flows through spec branches
# and PRs, so the trunk must stay clean.
$branch = git branch --show-current
if ($branch -eq "main" -or $branch -eq "master") {
  [Console]::Error.WriteLine("Blocked: direct commits to '$branch' are not allowed. Work on a branch and open a PR.")
  exit 1
}
exit 0
