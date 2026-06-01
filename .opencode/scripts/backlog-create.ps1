param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$BodyFile
)

$Title = $Title -replace '^(BL#\d+-|SP#\d+-|BUG-SP#\d+-|SP-pending-)', ''

if (-not (Test-Path $BodyFile)) {
  Write-Error "Body file not found: $BodyFile"
  exit 1
}

$issue = gh issue create --title "BL-$Title" --body-file $BodyFile --label "backlog" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create issue: $issue"
  exit 1
}

$issueNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
if (-not $issueNumber) {
  $issueNumber = (gh issue list --limit 1 --json number -q '.[0].number')
}

gh issue edit $issueNumber --title "BL#$issueNumber-$Title"

Remove-Item $BodyFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Backlog created:"
Write-Host "  Issue: #$issueNumber"
Write-Host "  Label: backlog"
