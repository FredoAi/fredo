param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$BodyFile
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "backlog-create.ps1" -Body {
  if (-not (Test-Path $BodyFile)) {
    throw "Body file not found: $BodyFile"
  }

  $cleanTitle = $Title -replace '^(BL#\d+-|SP#\d+-|BUG-SP#\d+-|SP-pending-)', ''

  $issue = gh issue create --title "BL-$cleanTitle" --body-file $BodyFile 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create issue: $issue"
  }

  $issueNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
  if (-not $issueNumber) {
    $issueNumber = (gh issue list --limit 1 --json number -q '.[0].number')
  }

  gh issue edit $issueNumber --title "BL#$issueNumber-$cleanTitle"

  $issueUrl = "https://github.com/FredoAi/fredo/issues/$issueNumber"
  $projOutput = gh project item-create 1 --owner FredoAi --url $issueUrl 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to add issue to project: $projOutput"
  }
  $projStatus = powershell -File .opencode/scripts/project-status.ps1 -IssueNumber $issueNumber -Status "Backlog" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set project status: $projStatus"
  }

  Write-Host ""
  Write-Host "Backlog created:"
  Write-Host "  Issue: #$issueNumber"
  Write-Host "  Project status: Backlog"
}