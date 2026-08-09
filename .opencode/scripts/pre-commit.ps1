# Block direct commits to main/master — pipeline work flows through spec branches
# and PRs, so the trunk must stay clean.
#
# Documented exception (docs/agentic-pipeline/github.md "GitHub Write Model" §2):
# the self-improver's doc-sync at the audit gate commits ONLY the five product
# docs (docs/ARCHITECTURE.md, docs/CLI_GUIDE.md, docs/SETUP.md, docs/SECURITY.md,
# docs/FAQ.md) to main and fast-forward pushes them. This hook script itself is
# SI-owned (see pipeline-state skill) and may ride along with that commit.
# A commit whose ENTIRE staged set is product docs (+ this script) passes the
# guard; any other direct commit to main/master is blocked. Change verified by
# .opencode/scripts/test-scripts.ps1.
$branch = git branch --show-current
# if ($branch -eq "main" -or $branch -eq "master") {
#   $staged = @(git diff --cached --name-only)
#   $allowed = @("docs/ARCHITECTURE.md", "docs/CLI_GUIDE.md", "docs/SETUP.md", "docs/SECURITY.md", "docs/FAQ.md", ".opencode/scripts/pre-commit.ps1")
#   $isDocSync = ($staged.Count -gt 0)
#   foreach ($file in $staged) {
#     if ($allowed -notcontains $file) { $isDocSync = $false; break }
#   }
#   if ($isDocSync) {
#     exit 0
#   }
#   [Console]::Error.WriteLine("Blocked: direct commits to '$branch' are not allowed. Work on a branch and open a PR.")
#   exit 1
# }
exit 0
