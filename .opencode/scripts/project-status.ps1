param(
  [Parameter(Mandatory=$true)][int]$IssueNumber,
  [Parameter(Mandatory=$true)][ValidateSet("Backlog","Planning","Coding","Reviewing","E2E","Done")][string]$Status
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "project-status.ps1" -IssueNumber "$IssueNumber" -Body {
  $projectId = "PVT_kwDOERTI7c4BZqwr"
  $statusFieldId = "PVTSSF_lADOERTI7c4BZqwrzhUn1e0"

  $optionIds = @{
    "Backlog"    = "f75ad846"
    "Planning"   = "47fc9ee4"
    "Coding"     = "d1cb6829"
    "Reviewing"  = "df73e18b"
    "E2E"        = "07ac1d28"
    "Done"       = "98236657"
  }

  $optionId = $optionIds[$Status]

  $json = gh project item-list 1 --owner FredoAi --format json --limit 100 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to list project items: $json"
  }

  $data = $json | ConvertFrom-Json
  $item = $data.items | Where-Object { $_.content.url -like "*/$IssueNumber" } | Select-Object -First 1
  if (-not $item) {
    throw "Issue #$IssueNumber not found in project. Ensure it was added via backlog-create.ps1 or spec-create.ps1."
  }
  $itemId = $item.id

  gh project item-edit --project-id $projectId --id $itemId --field-id $statusFieldId --single-select-option-id $optionId 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set status for issue #$IssueNumber"
  }

  Write-Host "Issue #${IssueNumber}: status set to `"$Status`""
}
