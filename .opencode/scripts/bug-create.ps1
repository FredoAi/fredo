param(
  [Parameter(Mandatory=$true)][string]$Description,
  [string]$EvidenceFile,
  [int]$ParentSpec,
  [string]$ReportedBy = "User",
  [string]$Feature = ""
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "bug-create.ps1" -ScriptBlock {
  $dateTag = Get-Date -Format "yyyyMMdd-HHmm"
  $shortDesc = $Description -replace '[^a-zA-Z0-9\s-]', ''
  if ($shortDesc.Length -gt 60) { $shortDesc = $shortDesc.Substring(0, 60) }
  $shortDesc = $shortDesc -replace '\s+', '-'

  # Build body
  $body = @"

## Bug

**Reported by:** $ReportedBy
**Date:** $(Get-Date -Format 'yyyy-MM-dd HH:mm')
**Feature:** $(if ($Feature) { $Feature } else { "(unknown)" })
**Parent spec:** $(if ($ParentSpec) { "#$ParentSpec" } else { "(none)" })

### Description

$Description

### Evidence

$(if ($EvidenceFile -and (Test-Path $EvidenceFile)) {
  Get-Content $EvidenceFile -Raw
} else {
  "_No evidence attached yet. Awaiting investigation._"
})

### Resolution

_To be filled by Architect after fix design._

---
*Authored by Product Owner*
"@

  $bodyFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $bodyFile -Value $body -Encoding UTF8

  # Create bug issue
  $title = "BUG#pending-$shortDesc"
  $issue = gh issue create --title $title --body-file $bodyFile --label bug 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $bodyFile -ErrorAction SilentlyContinue
    throw "Failed to create bug issue: $issue"
  }

  $issueNumber = ($issue -split '\s+')[0] -replace '[^0-9]', ''
  if (-not $issueNumber) {
    $issueNumber = (gh issue list --limit 1 --state open --label bug --json number -q '.[0].number')
  }

  gh issue edit $issueNumber --title "BUG#$issueNumber-$shortDesc"

  # Add to project and set Triage status
  $issueUrl = "https://github.com/FredoAi/fredo/issues/$issueNumber"
  $projOutput = gh project item-create 1 --owner FredoAi --url $issueUrl 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: Failed to add bug to project: $projOutput"
  } else {
    $projStatus = powershell -File .opencode/scripts/project-status.ps1 -IssueNumber $issueNumber -Status "Backlog" 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Warning: Failed to set project status: $projStatus"
    }
  }

  # Link parent spec if provided
  if ($ParentSpec) {
    $linkBody = "Bug created for spec #$ParentSpec: #$issueNumber"
    $linkFile = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $linkFile -Value $linkBody -Encoding UTF8
    powershell -File .opencode/scripts/git-ops-comment.ps1 -IssueNumber $ParentSpec -BodyFile $linkFile 2>&1 | Out-Null
    Remove-Item $linkFile -ErrorAction SilentlyContinue
  }

  Remove-Item $bodyFile -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "Bug created:"
  Write-Host "  Issue: #$issueNumber"
  Write-Host "  Parent spec: $(if ($ParentSpec) { "#$ParentSpec" } else { "none" })"
  Write-Host "  Project status: Backlog"
}
