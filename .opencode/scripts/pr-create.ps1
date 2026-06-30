param(
  [Parameter(Mandatory=$true)][int]$BacklogIssue,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [Parameter(Mandatory=$true)][string]$CapsuleName
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "pr-create.ps1" -IssueNumber "$BacklogIssue" -ScriptBlock {
  $Slug = $CapsuleName -replace '\s+', '-' -replace '[^a-zA-Z0-9-]', ''
  $Slug = $Slug.ToLower() -replace '-+', '-'
  $branchName = "feat/$BacklogIssue-$Slug"

  $prTitle = "$CapsuleName (Backlog #$BacklogIssue)"

  $prBody = @"
## Summary
Implementation of capsule: $CapsuleName

Backlog: #$BacklogIssue

---
*Authored by Coder*
"@

  $templateVars = [regex]::Matches($prBody, '\{\{[^}]+\}\}')
  if ($templateVars.Count -gt 0) {
    $msg = "PR body contains unfilled template variables:`n"
    foreach ($match in $templateVars) {
      $msg += "  $($match.Value)`n"
    }
    $msg += "Fill all template variables before creating the PR."
    throw $msg
  }

  $mergeBase = git merge-base $SpecBranch $branchName 2>&1
  if ($LASTEXITCODE -ne 0 -or -not $mergeBase) {
    throw "No common ancestor between '$SpecBranch' and '$branchName'. Push commits to the branch before creating a PR."
  }

  $tempFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tempFile -Value $prBody -Encoding UTF8

  $pr = gh pr create --draft --base $SpecBranch --head $branchName --title $prTitle --body-file $tempFile 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $tempFile -ErrorAction SilentlyContinue
    throw "Failed to create PR: $pr"
  }

  $prNumber = ($pr -split '\s+')[0] -replace '[^0-9]', ''
  if (-not $prNumber) {
    $prUrl = $pr | Select-String '(?:/pull/)(\d+)'
    if ($prUrl) { $prNumber = $prUrl.Matches[0].Groups[1].Value }
  }

  Remove-Item $tempFile -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "PR created:"
  Write-Host "  PR: #$prNumber (draft)"
  Write-Host "  Branch: $branchName -> $SpecBranch"
  Write-Host "  Backlog: #$BacklogIssue"
  Write-Host "  Capsule: $CapsuleName"
}