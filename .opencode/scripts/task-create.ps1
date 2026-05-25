param(
  [Parameter(Mandatory=$true)][int]$SpecIssue,
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$CapsuleFile,
  [Parameter(Mandatory=$true)][string]$SpecBranch
)

if (-not (Test-Path $CapsuleFile)) {
  Write-Error "Capsule file not found: $CapsuleFile"
  exit 1
}

$capsule = Get-Content $CapsuleFile -Raw
$template = @"
<!-- TITLE: SP#$SpecIssue-Task-$Title -->

## Task: $Title

$capsule

---
*Authored by @fredo*
"@

$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value $template

$issue = gh issue create --title "SP#$SpecIssue-Task-$Title" --body-file $tempFile --label "task:available" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create issue: $issue"
  Remove-Item $tempFile -ErrorAction SilentlyContinue
  Remove-Item $CapsuleFile -ErrorAction SilentlyContinue
  exit 1
}

$taskNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
if (-not $taskNumber) {
  $taskNumber = (gh issue list --limit 1 --json number -q '.[0].number')
}

$specBody = gh issue view $SpecIssue --json body -q '.body'
if ($specBody -match "### Tasks") {
  $taskLine = "- [ ] #$taskNumber — $Title"
  $updatedBody = $specBody -replace "(### Tasks\s*)", "`$1$taskLine`n"
  gh issue edit $SpecIssue --body $updatedBody
}

Remove-Item $tempFile -ErrorAction SilentlyContinue
Remove-Item $CapsuleFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Task created:"
Write-Host "  Task issue: #$taskNumber"
Write-Host "  Spec issue: #$SpecIssue"
Write-Host "  Spec branch: $SpecBranch"