param(
  [Parameter(Mandatory=$true)][int]$ParentIssue,
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$BodyFile,
  [string]$Label = ""
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "sub-issue-create.ps1" -IssueNumber "$ParentIssue" -Body {
  if (-not (Test-Path $BodyFile)) {
    throw "Body file not found: $BodyFile"
  }

  Write-Host "Creating sub-issue under parent #$ParentIssue..."
  Write-Host "  Title: $Title"

  $labelArgs = @()
  if ($Label) {
    $labelArgs = @("--label", $Label)
  }

  $createResult = gh issue create --title $Title --body-file $BodyFile @labelArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create issue: $createResult"
  }

  $childUrl = $createResult.Trim()
  if ($childUrl -match '/issues/(\d+)$') {
    $childNumber = [int]$Matches[1]
  } else {
    throw "Could not parse issue number from URL: $childUrl"
  }
  Write-Host "  Created issue #${childNumber}: $childUrl"

  # Trim to remove any trailing newlines/whitespace from gh output — GraphQL
  # mutation requires a clean ID string (Specs #295, #303, #311: "invalid value" errors)
  $parentId = (gh issue view $ParentIssue --json id --jq '.id' 2>&1).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($parentId)) {
    throw "Failed to get parent issue ID: $parentId"
  }

  $childId = (gh issue view $childNumber --json id --jq '.id' 2>&1).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($childId)) {
    throw "Failed to get child issue ID: $childId"
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
    Write-Host "  Issue #$childNumber created but NOT linked. Link manually."
    throw "Failed to link sub-issue: $linkResult"
  }

  Write-Host "  Linked: #$childNumber is now a sub-issue of #$ParentIssue"
  Write-Host ""
  Write-Host $childNumber
}