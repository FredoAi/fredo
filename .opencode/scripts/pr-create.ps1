param(
  [Parameter(Mandatory=$true)][int]$TaskIssue,
  [Parameter(Mandatory=$true)][int]$SpecIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [Parameter(Mandatory=$true)][string]$Type,
  [string]$Slug = ""
)

if (-not $Slug) {
  $Slug = "task-$TaskIssue"
}

$branchName = "feat/$TaskIssue-$Slug"
$taskBody = gh issue view $TaskIssue --json body -q '.body'

$requirementMatch = [regex]::Match($taskBody, 'requirement_ids:\s*\[([^\]]+)\]')
$requirements = if ($requirementMatch.Success) { $requirementMatch.Groups[1].Value } else { "See task issue" }

$summaryMatch = [regex]::Match($taskBody, '## Task:\s*(.+)')
$summary = if ($summaryMatch.Success) { $summaryMatch.Groups[1].Value.Trim() } else { "Task #$TaskIssue" }

$prTitle = "SP#$SpecIssue-$summary"

$prBody = @"
## Summary
Implementation of task #$TaskIssue for spec #$SpecIssue.

## Requirements Covered
$requirements

Closes #$TaskIssue

---
*Authored by @fredo*
"@

$templateVars = [regex]::Matches($prBody, '\{\{[^}]+\}\}')
if ($templateVars.Count -gt 0) {
  Write-Error "PR body contains unfilled template variables:"
  foreach ($match in $templateVars) {
    Write-Error "  $($match.Value)"
  }
  Write-Error "Fill all template variables before creating the PR."
  exit 1
}

$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value $prBody

$pr = gh pr create --draft --base $SpecBranch --head $branchName --title $prTitle --body-file $tempFile 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create PR: $pr"
  Remove-Item $tempFile -ErrorAction SilentlyContinue
  exit 1
}

$prNumber = ($pr -split '\s+')[0] -replace '[^0-9]', ''
if (-not $prNumber) {
  $prUrl = $pr | Select-String '(?:/pull/)(\d+)'
  if ($prUrl) { $prNumber = $prUrl.Matches[0].Groups[1].Value }
}

Remove-Item $tempFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "PR created:"
Write-Host "  PR: #$prNumber"
Write-Host "  Branch: $branchName -> $SpecBranch"
Write-Host "  Task issue: #$TaskIssue"
Write-Host "  Spec issue: #$SpecIssue"