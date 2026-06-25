param(
  [Parameter(Mandatory=$true)][int]$IssueNumber,
  [Parameter(Mandatory=$true)][string]$ScreenshotDir,
  [string]$Repo = "FredoAi/fredo",
  [switch]$PostComment
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "e2e-attach-screenshots.ps1" -IssueNumber "$IssueNumber" -Body {
  $ErrorActionPreference = "Continue"

  if (-not (Test-Path $ScreenshotDir)) {
    throw "Screenshot directory not found: $ScreenshotDir"
  }

  $screenshots = @(Get-ChildItem -Path $ScreenshotDir -Filter "*.jpeg" -ErrorAction SilentlyContinue)
  if ($screenshots.Count -eq 0) {
    $screenshots = @(Get-ChildItem -Path $ScreenshotDir -Filter "*.png" -ErrorAction SilentlyContinue)
  }
  if ($screenshots.Count -eq 0) {
    Write-Warning "No screenshots found in $ScreenshotDir"
    return
  }

  Write-Host "=== Uploading $($screenshots.Count) screenshots via gh-image ==="

  $markdown = @("## E2E Screenshots -- Backlog #$IssueNumber", "")
  $uploaded = 0
  $failed = 0

  foreach ($shot in $screenshots) {
    $acLabel = $shot.BaseName -replace 'ac-', 'AC-'
    Write-Host "  $($shot.Name) ..." -NoNewline

    $env:GH_SESSION_TOKEN = (gh auth token 2>&1)
    $result = gh image $shot.FullName --repo $Repo 2>&1
    if ($LASTEXITCODE -eq 0) {
      $url = $result.Trim()
      Write-Host " OK" -ForegroundColor Green
      $markdown += "### $acLabel"
      $markdown += $url
      $markdown += ""
      $uploaded++
    } else {
      Write-Host " FAIL ($result)" -ForegroundColor Red
      $markdown += "### $acLabel *[upload failed]*"
      $markdown += "*Local: $($shot.FullName)*"
      $markdown += ""
      $failed++
    }
  }

  if ($uploaded -gt 0) {
    Remove-Item -Recurse -Force $ScreenshotDir -ErrorAction SilentlyContinue
  }

  if ($PostComment) {
    $temp = [System.IO.Path]::GetTempFileName()
    $markdown -join "`n" | Set-Content -Path $temp -Encoding UTF8
    gh issue comment $IssueNumber --body-file $temp 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Remove-Item $temp -ErrorAction SilentlyContinue
      throw "Failed to post screenshot comment on issue #$IssueNumber"
    }
    Remove-Item $temp -ErrorAction SilentlyContinue
    Write-Host "Posted as comment on issue #$IssueNumber"
  }

  Write-Host "Uploaded: $uploaded / $($screenshots.Count) (failed: $failed)"
  $markdown -join "`n"
}