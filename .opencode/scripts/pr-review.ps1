param(
  [Parameter(Mandatory=$true)][ValidateSet("approve","request-changes")][string]$Action,
  [Parameter(Mandatory=$true)][int]$PrNumber,
  [Parameter(Mandatory=$true)][string]$SpecBranch,
  [string]$ReviewFile,
  [int]$SubIssueNumber = 0
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "pr-review.ps1" -Body {
  if ($Action -eq "approve") {
    $ciChecks = gh pr checks $PrNumber 2>&1
    if ($LASTEXITCODE -eq 0) {
      $failingChecks = $ciChecks | Where-Object { $_ -match 'fail' -or $_ -match 'error' }
      if ($failingChecks) {
        $msg = "CI checks failing on PR #$PrNumber. Cannot merge.`nFailing checks:`n"
        foreach ($c in $failingChecks) { $msg += "  $c`n" }
        throw $msg
      }
    }

    if (-not $ReviewFile) {
      $reviewBody = @"
## Approved

All acceptance criteria met. Scope is correct. Patterns followed.

---
*Reviewed by @fredo*
"@
    } else {
      $reviewBody = Get-Content $ReviewFile -Raw
    }

    $tempFile = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $tempFile -Value $reviewBody -Encoding UTF8
    gh pr review $PrNumber --approve --body-file $tempFile
    if ($LASTEXITCODE -ne 0) {
      Remove-Item $tempFile -ErrorAction SilentlyContinue
      throw "Failed to approve PR #$PrNumber"
    }
    Remove-Item $tempFile -ErrorAction SilentlyContinue

    $prState = gh pr view $PrNumber --json state --jq '.state' 2>&1
    if ($LASTEXITCODE -eq 0 -and $prState -ne 'OPEN') {
      Write-Host "  PR #$PrNumber is $prState — marking ready for review"
      gh pr ready $PrNumber 2>&1 | Out-Null
    }

    gh pr merge $PrNumber --squash --delete-branch
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to merge PR #$PrNumber into $SpecBranch"
    }

    Write-Host ""
    Write-Host "PR #$PrNumber approved and merged into $SpecBranch"

    if ($SubIssueNumber -gt 0) {
      gh issue close $SubIssueNumber --reason completed 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Sub-issue #$SubIssueNumber closed"
      } else {
        Write-Warning "Failed to close sub-issue #$SubIssueNumber"
      }
    }
    return
  }

  if ($Action -eq "request-changes") {
    if (-not $ReviewFile) {
      throw "ReviewFile is required for request-changes action"
    }

    $reviewBody = Get-Content $ReviewFile -Raw
    $tempFile = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $tempFile -Value $reviewBody -Encoding UTF8
    gh pr review $PrNumber --request-changes --body-file $tempFile
    if ($LASTEXITCODE -ne 0) {
      Remove-Item $tempFile -ErrorAction SilentlyContinue
      throw "Failed to request changes on PR #$PrNumber"
    }
    Remove-Item $tempFile -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "Changes requested on PR #$PrNumber"
    return
  }

  if ($ReviewFile -and (Test-Path $ReviewFile -ErrorAction SilentlyContinue)) {
    Remove-Item $ReviewFile -ErrorAction SilentlyContinue
  }
}