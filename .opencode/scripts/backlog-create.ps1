param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$BodyFile
)

if (-not (Test-Path $BodyFile)) {
  Write-Error "Body file not found: $BodyFile"
  exit 1
}

$Title = $Title -replace '^(BL#\d+-|SP#\d+-|BUG-SP#\d+-|SP-pending-)', ''

$issue = gh issue create --title "BL-$Title" --body-file $BodyFile 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create issue: $issue"
  exit 1
}

$issueNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
if (-not $issueNumber) {
  $issueNumber = (gh issue list --limit 1 --json number -q '.[0].number')
}

gh issue edit $issueNumber --title "BL#$issueNumber-$Title"

$issueUrl = "https://github.com/FredoAi/fredo/issues/$issueNumber"
gh project item-create 1 --owner FredoAi --url $issueUrl 2>&1 | Out-Null
powershell -File .opencode/scripts/project-status.ps1 -IssueNumber $issueNumber -Status "Backlog"

Remove-Item $BodyFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Backlog created:"
Write-Host "  Issue: #$issueNumber"
Write-Host "  Project status: Backlog"
