param(
  [Parameter(Mandatory=$true)][int]$BacklogIssue
)

Write-Host "=== Domain Model Validation for Backlog #$BacklogIssue ==="

$comments = gh issue view $BacklogIssue --comments --json comments --jq '.comments[].body' 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to read backlog comments: $comments"
  exit 1
}

$specComment = $comments | Where-Object { $_ -match '## Domain Model' } | Select-Object -First 1
if (-not $specComment) {
  Write-Error "FAIL: No Domain Model section found in spec comment on backlog #$BacklogIssue"
  Write-Output "FAIL:missing_domain_model"
  exit 1
}

$domainSection = if ($specComment -match '## Domain Model\n([\s\S]*?)(?=\n## |\Z)') {
  $Matches[1].Trim()
} else {
  ""
}

$bullets = ($domainSection -split "`n" | Where-Object { $_ -match '^\s*-\s' })
if ($bullets.Count -lt 3) {
  Write-Error "FAIL: Domain Model has fewer than 3 bullets (found $($bullets.Count))."
  Write-Output "FAIL:insufficient_domain_bullets"
  exit 1
}

$hasLineCitation = ($bullets | Where-Object { $_ -match '\[.*:\d+' }).Count
if ($hasLineCitation -lt 2) {
  Write-Error "FAIL: Fewer than 2 domain model bullets cite file:line (found $hasLineCitation)."
  Write-Output "FAIL:missing_file_line_citations"
  exit 1
}

$reqSection = if ($specComment -match '## Requirements[^#]*\n([\s\S]*?)(?=\n## |\Z)') {
  $Matches[1].Trim()
} else {
  ""
}

$reqIds = [regex]::Matches($reqSection, 'REQ-(\d+)') | ForEach-Object { "REQ-$($_.Groups[1].Value)" } | Sort-Object -Unique

$coveredReqs = @()
foreach ($reqId in $reqIds) {
  $reqNum = $reqId -replace 'REQ-', ''
  $prefixes = @("REQ-$reqNum", "req_$reqNum", "REQ $reqNum")
  foreach ($bullet in $bullets) {
    if ($prefixes | Where-Object { $bullet -match $_ }) {
      $coveredReqs += $reqId
      break
    }
  }
}

$uncovered = $reqIds | Where-Object { $_ -notin $coveredReqs }
if ($uncovered) {
  Write-Error "FAIL: $($uncovered.Count) EARS requirements not covered by Domain Model:"
  $uncovered | ForEach-Object { Write-Error "  $_" }
  Write-Output "FAIL:uncovered_requirements"
  exit 1
}

Write-Host "  Domain Model bullets: $($bullets.Count) (with file:line citations: $hasLineCitation)"
Write-Host "  EARS requirements: $($reqIds.Count) (all covered by Domain Model)"
Write-Host "`n=== Domain Model: PASS ==="
Write-Output "PASS"
