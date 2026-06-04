param(
  [Parameter(Mandatory=$true)][int]$IssueNumber,
  [Parameter(Mandatory=$true)][ValidateSet("Backlog","In progress","In review","Done")][string]$Status
)

$projectId = "PVT_kwDOERTI7c4BZqwr"
$statusFieldId = "PVTSSF_lADOERTI7c4BZqwrzhUn1e0"

$optionIds = @{
  "Backlog"     = "f75ad846"
  "In progress" = "47fc9ee4"
  "In review"   = "df73e18b"
  "Done"        = "98236657"
}

$optionId = $optionIds[$Status]

$itemId = gh project item-list 1 --owner FredoAi --format json -q ".items[] | select(.content.url | endswith(\"/$IssueNumber\")) | .id" 2>&1

if (-not $itemId -or $LASTEXITCODE -ne 0) {
  Write-Error "Failed to find project item for issue #$IssueNumber`: $itemId"
  exit 1
}

gh project item-edit --project-id $projectId --id $itemId --field-id $statusFieldId --single-select-option-id $optionId 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to set status for issue #$IssueNumber"
  exit 1
}

Write-Host "Issue #$IssueNumber: status set to `"$Status`""
