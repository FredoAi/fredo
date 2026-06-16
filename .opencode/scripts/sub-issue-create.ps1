param(
  [Parameter(Mandatory=$true)][int]$ParentIssue,
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$BodyFile,
  [string]$Label = ""
)

if (-not (Test-Path $BodyFile)) {
  Write-Error "Body file not found: $BodyFile"
  exit 1
}

Write-Host "Creating sub-issue under parent #$ParentIssue..."
Write-Host "  Title: $Title"

$bodyContent = Get-Content $BodyFile -Raw

$labelArgs = @()
if ($Label) {
  $labelArgs = @("--label", $Label)
}

$createResult = gh issue create --title $Title --body $bodyContent @labelArgs --json number,url 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create issue: $createResult"
  exit 1
}

$issueData = $createResult | ConvertFrom-Json
$childNumber = $issueData.number
$childUrl = $issueData.url
Write-Host "  Created issue #$childNumber: $childUrl"

$parentId = gh issue view $ParentIssue --json id --jq '.id' 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to get parent issue ID: $parentId"
  exit 1
}

$childId = gh issue view $childNumber --json id --jq '.id' 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to get child issue ID: $childId"
  exit 1
}

Write-Host "  Linking as sub-issue..."

$query = @"
mutation {
  addSubIssue(input: {
    issueId: "$parentId",
    subIssueId: "$childId"
  }) {
    clientMutationId
  }
}
"@

$linkResult = gh api graphql -f query=$query 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to link sub-issue: $linkResult"
  Write-Host "  Issue #$childNumber created but NOT linked. Link manually."
  exit 1
}

Write-Host "  Linked: #$childNumber is now a sub-issue of #$ParentIssue"
Write-Host ""
Write-Host $childNumber
