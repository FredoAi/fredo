param(
  [Parameter(Mandatory=$true)][int]$IssueNumber,
  [string]$Body,
  [string]$BodyFile
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "git-ops-comment.ps1" -IssueNumber "$IssueNumber" -Body {
  if (-not $Body -and -not $BodyFile) {
    throw "Either -Body or -BodyFile is required"
  }

  $temp = [System.IO.Path]::GetTempFileName()

  if ($Body) {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($temp, $Body, $utf8)
  } else {
    if (-not (Test-Path $BodyFile)) {
      Remove-Item $temp -ErrorAction SilentlyContinue
      throw "Body file not found: $BodyFile"
    }
    Copy-Item $BodyFile $temp -Force
  }

  gh issue comment $IssueNumber --body-file $temp 2>&1 | Out-Null
  $exitCode = $LASTEXITCODE
  Remove-Item $temp -ErrorAction SilentlyContinue

  if ($exitCode -ne 0) {
    throw "Failed to post comment on issue #$IssueNumber"
  }

  Write-Host "Comment posted on issue #$IssueNumber"
}
