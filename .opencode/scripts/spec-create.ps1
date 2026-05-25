param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Branch,
  [Parameter(Mandatory=$true)][string]$BodyFile
)

if (-not (Test-Path $BodyFile)) {
  Write-Error "Body file not found: $BodyFile"
  exit 1
}

$issue = gh issue create --title "SP-pending-$Title" --body-file $BodyFile --label "spec:active" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create issue: $issue"
  exit 1
}

$issueNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
if (-not $issueNumber) {
  $issueNumber = (gh issue list --limit 1 --json number -q '.[0].number')
}

$updatedTitle = "SP#$issueNumber-$Title"
gh issue edit $issueNumber --title $updatedTitle

git checkout main
git pull origin main
git checkout -b "spec/$issueNumber-$Branch"
git push -u origin "spec/$issueNumber-$Branch"

$adrDir = "docs/adr"
$contractDir = "docs/contracts"
if (-not (Test-Path "$adrDir/$issueNumber-$Branch.md")) {
  Set-Content -Path "$adrDir/$issueNumber-$Branch.md" -Value @"
# ADR-$issueNumber`: $($Title -replace '-', ' ')

## Status
Proposed

## Context
_To be filled by architect._

## Decision
_To be filled by architect._

## Consequences
### Positive
- 

### Negative
- 

### Risks
- 
"@
  git add "$adrDir/$issueNumber-$Branch.md"
}

if (-not (Test-Path "$contractDir/$Branch.md")) {
  Set-Content -Path "$contractDir/$Branch.md" -Value @"
# Contract: $($Title -replace '-', ' ')

## Public Interface
_To be filled by architect._

## Events Emitted
_To be filled by architect._

## State Managed
_To be filled by architect._

## Dependencies
_To be filled by architect._

## Forbidden Changes
_To be filled by architect._
"@
  git add "$contractDir/$Branch.md"
}

git commit -m "docs: add ADR-$issueNumber and contract for $Title"
git push origin "spec/$issueNumber-$Branch"

Write-Host ""
Write-Host "Spec created:"
Write-Host "  Issue: #$issueNumber"
Write-Host "  Branch: spec/$issueNumber-$Branch"
Write-Host "  ADR: docs/adr/$issueNumber-$Branch.md"
Write-Host "  Contract: docs/contracts/$Branch.md"

Remove-Item $BodyFile -ErrorAction SilentlyContinue